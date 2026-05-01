require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const logger = require('../services/logger');

const COST_INPUT_PER_M = 3.0;
const COST_OUTPUT_PER_M = 15.0;

async function rollupForDate(dateStr) {
  const inbound = await pg.query(
    `SELECT COUNT(*)::int AS n FROM crm_messages
     WHERE direction = 'in' AND created_at::date = $1::date`, [dateStr]
  );
  const aiSent = await pg.query(
    `SELECT COUNT(*)::int AS n FROM crm_messages
     WHERE sender_type = 'ai' AND shadow = FALSE AND created_at::date = $1::date`, [dateStr]
  );
  const handovers = await pg.query(
    `SELECT COUNT(*)::int AS n FROM crm_handovers WHERE created_at::date = $1::date`, [dateStr]
  );
  const uniqConv = await pg.query(
    `SELECT COUNT(DISTINCT conversation_id)::int AS n FROM crm_messages
     WHERE created_at::date = $1::date`, [dateStr]
  );
  const tokens = await pg.query(
    `SELECT
       COALESCE(SUM((ai_metadata->>'tokens_in')::int), 0)::bigint  AS tin,
       COALESCE(SUM((ai_metadata->>'tokens_out')::int), 0)::bigint AS tout,
       COALESCE(AVG((ai_metadata->>'latency_ms')::int), 0)::int    AS avg_lat
     FROM crm_messages
     WHERE sender_type = 'ai' AND ai_metadata IS NOT NULL AND created_at::date = $1::date`,
    [dateStr]
  );
  const breakdown = await pg.query(
    `SELECT reason, COUNT(*)::int AS n
     FROM crm_handovers WHERE created_at::date = $1::date
     GROUP BY reason`, [dateStr]
  );

  const tin = Number(tokens.rows[0].tin || 0);
  const tout = Number(tokens.rows[0].tout || 0);
  const cost = (tin / 1_000_000) * COST_INPUT_PER_M + (tout / 1_000_000) * COST_OUTPUT_PER_M;

  const breakdownObj = {};
  for (const r of breakdown.rows) breakdownObj[r.reason] = r.n;

  await pg.query(
    `INSERT INTO crm_ai_metrics_daily
       (date, total_inbound, total_ai_sent, total_handovers, unique_conversations,
        avg_latency_ms, total_tokens_in, total_tokens_out, cost_usd, handover_breakdown)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (date) DO UPDATE SET
       total_inbound = EXCLUDED.total_inbound,
       total_ai_sent = EXCLUDED.total_ai_sent,
       total_handovers = EXCLUDED.total_handovers,
       unique_conversations = EXCLUDED.unique_conversations,
       avg_latency_ms = EXCLUDED.avg_latency_ms,
       total_tokens_in = EXCLUDED.total_tokens_in,
       total_tokens_out = EXCLUDED.total_tokens_out,
       cost_usd = EXCLUDED.cost_usd,
       handover_breakdown = EXCLUDED.handover_breakdown`,
    [dateStr, inbound.rows[0].n, aiSent.rows[0].n, handovers.rows[0].n, uniqConv.rows[0].n,
     tokens.rows[0].avg_lat, tin, tout, cost.toFixed(4), breakdownObj]
  );

  return {
    date: dateStr,
    inbound: inbound.rows[0].n,
    ai_sent: aiSent.rows[0].n,
    handovers: handovers.rows[0].n,
    cost_usd: cost.toFixed(4),
  };
}

async function run() {
  const arg = process.argv[2];
  const date = arg || (() => {
    const d = new Date(Date.now() - 86400000);
    return d.toISOString().slice(0, 10);
  })();
  const result = await rollupForDate(date);
  logger.info(result, '[rollup] done');
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[rollup] failed'); process.exit(1); });
}

module.exports = { rollupForDate };
