// One-shot backfill: assign pipeline_stage to every existing conversation
// based on history available. Run AFTER migration 013 applied.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const logger = require('../services/logger');

const BATCH = 500;

async function inferStageForConv(c) {
  const out = {
    stage: null, lost_reason: null, lost_note: null,
    type: 'unknown', deal_order_id: null, deal_value_idr: null,
  };

  // Spam check
  const spam = await pg.query(`SELECT 1 FROM crm_spam_blocks WHERE phone = $1 AND released_at IS NULL`, [c.phone]);
  if (spam.rows.length) {
    out.stage = 'lost'; out.lost_reason = 'other_with_note'; out.lost_note = 'spam_block';
    return out;
  }

  const refund = await pg.query(
    `SELECT 1 FROM crm_handovers WHERE conversation_id = $1 AND reason = 'refund' AND resolved_at IS NOT NULL LIMIT 1`,
    [c.id]
  );
  if (refund.rows.length) { out.stage = 'lost'; out.lost_reason = 'refund_complaint'; return out; }

  const cancel = await pg.query(
    `SELECT 1 FROM crm_handovers WHERE conversation_id = $1 AND reason = 'cancel' AND resolved_at IS NOT NULL LIMIT 1`,
    [c.id]
  );
  if (cancel.rows.length) { out.stage = 'lost'; out.lost_reason = 'cancelled'; return out; }

  // Try MySQL order match by UTM ref
  if (c.last_order_url_ref) {
    try {
      const [orders] = await mysql.query(
        `SELECT o.id, o.total, o.payment_status, MAX(oi.date_time) AS delivery_date,
                LOWER(MAX(c.name)) AS category
         FROM \`order\` o
         LEFT JOIN order_items oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
         LEFT JOIN products p ON p.id = oi.product_id
         LEFT JOIN product_category_new c ON c.id = p.category_id
         WHERE o.utm_content = ? AND o.deleted_at IS NULL
         GROUP BY o.id, o.total, o.payment_status
         ORDER BY o.id DESC LIMIT 1`,
        [c.last_order_url_ref]
      );
      if (orders[0]) {
        out.deal_order_id = orders[0].id;
        out.deal_value_idr = Number(orders[0].total) || null;
        const cat = orders[0].category || '';
        const map = { 'papan': 'papan', 'bouquet': 'bouquet', 'parsel': 'parsel', 'cake': 'cake', 'kue': 'cake' };
        for (const k of Object.keys(map)) if (cat.includes(k)) { out.type = map[k]; break; }
        if (orders[0].payment_status === 'paid' && orders[0].delivery_date && new Date(orders[0].delivery_date) <= new Date()) {
          out.stage = 'delivered'; return out;
        }
        if (orders[0].payment_status === 'paid') { out.stage = 'paid'; return out; }
        out.stage = 'order_submitted'; return out;
      }
    } catch (err) { /* mysql query failed; continue */ }
  }

  const lastMsgAge = c.last_message_at ? (Date.now() - new Date(c.last_message_at).getTime()) / 86400000 : 999;

  if (c.last_order_url_sent_at) {
    if (lastMsgAge > 3) { out.stage = 'lost'; out.lost_reason = 'no_reply'; return out; }
    out.stage = 'form_dikirim'; return out;
  }

  if (c.status === 'closed') {
    const staffOut = await pg.query(
      `SELECT 1 FROM crm_messages WHERE conversation_id = $1 AND direction = 'out' AND sender_type = 'staff' LIMIT 1`,
      [c.id]
    );
    if (staffOut.rows.length) { out.stage = 'delivered'; return out; }
  }

  if (c.assigned_staff_id && lastMsgAge < 7) { out.stage = 'tertarik'; return out; }

  if (['order_intent', 'pricing', 'shipping', 'payment'].includes(c.last_intent)) {
    if (lastMsgAge > 3) { out.stage = 'lost'; out.lost_reason = 'no_reply'; return out; }
    out.stage = 'tertarik'; return out;
  }

  if (lastMsgAge > 7) { out.stage = 'lost'; out.lost_reason = 'no_reply'; return out; }
  out.stage = 'baru';
  return out;
}

async function processBatch(offset) {
  const { rows } = await pg.query(
    `SELECT id, phone, status, last_message_at, last_intent, last_order_url_sent_at,
            last_order_url_ref, assigned_staff_id, customer_id
     FROM crm_conversations
     ORDER BY id LIMIT $1 OFFSET $2`,
    [BATCH, offset]
  );
  if (!rows.length) return 0;
  const counters = {};
  for (const c of rows) {
    const out = await inferStageForConv(c);
    const histEntry = JSON.stringify({
      stage: out.stage, at: c.last_message_at || new Date().toISOString(), by: null, source: 'backfill',
    });
    await pg.query(
      `UPDATE crm_conversations SET
         pipeline_stage = $2,
         pipeline_stage_at = COALESCE(last_message_at, now()),
         pipeline_type = $3,
         deal_order_id = $4,
         deal_value_idr = $5,
         lost_reason = $6,
         lost_note = $7,
         pipeline_stage_history = $8::jsonb
       WHERE id = $1`,
      [c.id, out.stage, out.type, out.deal_order_id, out.deal_value_idr, out.lost_reason, out.lost_note, '[' + histEntry + ']']
    );
    await pg.query(
      `INSERT INTO crm_pipeline_events (conversation_id, from_stage, to_stage, source, metadata)
       VALUES ($1, NULL, $2, 'backfill', $3::jsonb)`,
      [c.id, out.stage, JSON.stringify({ inferred_type: out.type })]
    );
    counters[out.stage] = (counters[out.stage] || 0) + 1;
  }
  logger.info({ batch_offset: offset, count: rows.length, by_stage: counters }, '[backfill] batch done');
  return rows.length;
}

async function run() {
  const total = (await pg.query(`SELECT COUNT(*)::int AS n FROM crm_conversations`)).rows[0].n;
  logger.info({ total }, '[backfill] starting');
  let offset = 0;
  while (true) {
    const n = await processBatch(offset);
    if (n < BATCH) break;
    offset += BATCH;
  }
  const summary = await pg.query(
    `SELECT pipeline_stage, COUNT(*)::int AS n FROM crm_conversations GROUP BY pipeline_stage ORDER BY pipeline_stage`
  );
  logger.info({ summary: summary.rows }, '[backfill] done');
  await pg.end();
  await mysql.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message, stack: err.stack }, '[backfill] failed'); process.exit(1); });
}
module.exports = { run, inferStageForConv };
