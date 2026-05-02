// #4 Customer health score — daily 02:00 WIB.
// Score 0..100 = recency(30) + frequency(25) + AOV(20) + sentiment(15) + CSAT(10).
// Bands: ≥80 vip · 60-79 warm · 40-59 cold · <40 at_risk · 0 (no orders) new
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const logger = require('../services/logger');

function bandFor(score) {
  if (score >= 80) return 'vip';
  if (score >= 60) return 'warm';
  if (score >= 40) return 'cold';
  if (score > 0) return 'at_risk';
  return 'new';
}

function clamp(n, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, n)); }

async function compute(customerId) {
  const inputs = {};
  // Order history
  const [orders] = await mysql.query(
    `SELECT id, total, created_at, payment_status FROM \`order\`
     WHERE customer_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 50`,
    [customerId]
  );
  if (!orders.length) {
    return { score: 0, band: 'new', inputs: { orders: 0 } };
  }
  const paid = orders.filter((o) => o.payment_status === 'paid');
  inputs.orders = orders.length;
  inputs.paid_orders = paid.length;
  const aov = paid.length ? paid.reduce((s, o) => s + Number(o.total || 0), 0) / paid.length : 0;
  inputs.aov_idr = Math.round(aov);
  const lastOrder = orders[0].created_at;
  const daysSince = (Date.now() - new Date(lastOrder).getTime()) / 86400000;
  inputs.days_since_last_order = Math.round(daysSince);

  // Recency: 30pt if <30d, 20 if <90d, 10 if <180d, else 0
  const recencyPt = daysSince < 30 ? 30 : daysSince < 90 ? 20 : daysSince < 180 ? 10 : 0;
  // Frequency: 25 cap; ~5pt per order up to 5
  const freqPt = clamp(Math.min(paid.length, 5) * 5, 0, 25);
  // AOV: 20 cap; >1M=20, >500k=14, >250k=8, else 4
  const aovPt = aov > 1_000_000 ? 20 : aov > 500_000 ? 14 : aov > 250_000 ? 8 : aov > 0 ? 4 : 0;

  // Sentiment & CSAT pulled from PG via conv_id linked to this customer
  const sentRows = await pg.query(
    `SELECT
       COUNT(*) FILTER (WHERE m.sentiment = 'angry')      AS angry,
       COUNT(*) FILTER (WHERE m.sentiment = 'frustrated') AS frustrated,
       COUNT(*) FILTER (WHERE m.sentiment = 'positive')   AS positive,
       COUNT(*) FILTER (WHERE m.sentiment IS NOT NULL)    AS total
     FROM crm_messages m
     JOIN crm_conversations c ON c.id = m.conversation_id
     WHERE c.customer_id = $1 AND m.created_at > now() - interval '90 days'`,
    [customerId]
  );
  const s = sentRows.rows[0];
  inputs.sentiment = s;
  let sentPt = 15;
  if (Number(s.total) > 0) {
    const negRatio = (Number(s.angry) + Number(s.frustrated)) / Number(s.total);
    sentPt = clamp(Math.round(15 - negRatio * 25), -10, 15);
  }

  const csatRows = await pg.query(
    `SELECT AVG(score)::numeric AS avg, COUNT(*) AS n
     FROM crm_csat cs
     JOIN crm_conversations c ON c.id = cs.conversation_id
     WHERE c.customer_id = $1`,
    [customerId]
  );
  const cs = csatRows.rows[0];
  inputs.csat = cs;
  let csatPt = 5;
  if (Number(cs.n) > 0) {
    csatPt = clamp(Math.round((Number(cs.avg) - 2.5) * 4), -10, 10);
  }

  const score = clamp(recencyPt + freqPt + aovPt + sentPt + csatPt);
  return { score, band: bandFor(score), inputs };
}

async function run() {
  // Snapshot all customers who have a conversation in past 180d
  const { rows } = await pg.query(
    `SELECT DISTINCT customer_id FROM crm_conversations
     WHERE customer_id IS NOT NULL
       AND last_message_at > now() - interval '180 days'`
  );
  if (!rows.length) { logger.info('[health] no customers'); await pg.end(); await mysql.end(); return; }
  let ok = 0, fail = 0;
  for (const r of rows) {
    try {
      const out = await compute(r.customer_id);
      await pg.query(
        `INSERT INTO crm_customer_health (customer_id, score, band, inputs, computed_at)
         VALUES ($1, $2, $3, $4::jsonb, now())
         ON CONFLICT (customer_id) DO UPDATE SET
           score = EXCLUDED.score, band = EXCLUDED.band, inputs = EXCLUDED.inputs, computed_at = now()`,
        [r.customer_id, out.score, out.band, JSON.stringify(out.inputs)]
      );
      ok++;
    } catch (err) { fail++; logger.warn({ err: err.message, cid: r.customer_id }, '[health] one failed'); }
  }
  logger.info({ ok, fail }, '[health] done');
  await pg.end(); await mysql.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[health] failed'); process.exit(1); });
}

module.exports = { run, compute, bandFor };
