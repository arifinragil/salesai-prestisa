const pg = require('../db/postgres');
const settings = require('./settings');

// Same rates as scripts/dailyMetricsRollup.js
const COST_INPUT_PER_M = 3.0;
const COST_OUTPUT_PER_M = 15.0;

async function getTodayCostUsd() {
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await pg.query(
    `SELECT
       COALESCE(SUM((ai_metadata->>'tokens_in')::int), 0)::bigint  AS tin,
       COALESCE(SUM((ai_metadata->>'tokens_out')::int), 0)::bigint AS tout
     FROM crm_messages
     WHERE sender_type = 'ai' AND ai_metadata IS NOT NULL
       AND created_at::date = $1::date`,
    [today]
  );
  const tin = Number(rows[0].tin || 0);
  const tout = Number(rows[0].tout || 0);
  return (tin / 1_000_000) * COST_INPUT_PER_M + (tout / 1_000_000) * COST_OUTPUT_PER_M;
}

async function getCap() {
  const v = await settings.getSetting('daily_cost_cap_usd', null);
  if (v === null || v === undefined) {
    const env = parseFloat(process.env.AI_DAILY_COST_CAP_USD);
    return Number.isFinite(env) ? env : 5;
  }
  return typeof v === 'number' ? v : parseFloat(v);
}

async function checkCap() {
  const [current, cap] = await Promise.all([getTodayCostUsd(), getCap()]);
  return {
    current,
    cap,
    overCap: current >= cap,
    percent: cap > 0 ? Math.round((current / cap) * 100) : 0,
  };
}

module.exports = { getTodayCostUsd, getCap, checkCap, COST_INPUT_PER_M, COST_OUTPUT_PER_M };
