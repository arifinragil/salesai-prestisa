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

// Per-provider/model rates (USD per 1M tokens). Anthropic Sonnet 4.6 default
// rates; OpenAI gpt-4o-mini and Gemini 2.5 Pro added for breakdown accuracy.
// Anything not listed falls back to (3, 15) which is conservative.
const RATES = {
  'anthropic|claude-opus-4-7':   { in: 15, out: 75 },
  'anthropic|claude-opus-4-6':   { in: 15, out: 75 },
  'anthropic|claude-sonnet-4-6': { in: 3,  out: 15 },
  'anthropic|claude-haiku-4-5':  { in: 1,  out: 5 },
  'openai|gpt-4o':               { in: 2.5,out: 10 },
  'openai|gpt-4o-mini':          { in: 0.15, out: 0.6 },
  'openai|gpt-4-turbo':          { in: 10, out: 30 },
  'gemini|gemini-2.5-pro':       { in: 1.25, out: 10 },
  'gemini|gemini-2.5-flash':     { in: 0.3, out: 2.5 },
  'gemini|gemini-pro-latest':    { in: 1.25, out: 10 },
  'gemini|gemini-flash-latest':  { in: 0.3, out: 2.5 },
};

function rateFor(provider, model) {
  const key = `${provider || 'anthropic'}|${model || ''}`;
  return RATES[key] || { in: COST_INPUT_PER_M, out: COST_OUTPUT_PER_M };
}

function costFor(provider, model, tokensIn, tokensOut) {
  const r = rateFor(provider, model);
  return (Number(tokensIn || 0) / 1_000_000) * r.in
       + (Number(tokensOut || 0) / 1_000_000) * r.out;
}

async function getTodayBreakdown() {
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await pg.query(
    `SELECT
       COALESCE(ai_metadata->>'provider', 'anthropic') AS provider,
       COALESCE(ai_metadata->>'model', '?')             AS model,
       COUNT(*)::int                                    AS messages,
       COALESCE(SUM((ai_metadata->>'tokens_in')::int), 0)::bigint  AS tin,
       COALESCE(SUM((ai_metadata->>'tokens_out')::int), 0)::bigint AS tout
     FROM crm_messages
     WHERE sender_type = 'ai' AND ai_metadata IS NOT NULL
       AND created_at::date = $1::date
     GROUP BY provider, model
     ORDER BY tin DESC`,
    [today]
  );
  let totalCost = 0;
  let totalIn = 0, totalOut = 0, totalMessages = 0;
  const items = rows.map((r) => {
    const cost = costFor(r.provider, r.model, r.tin, r.tout);
    totalCost += cost;
    totalIn += Number(r.tin);
    totalOut += Number(r.tout);
    totalMessages += r.messages;
    return {
      provider: r.provider,
      model: r.model,
      messages: r.messages,
      tokens_in: Number(r.tin),
      tokens_out: Number(r.tout),
      cost_usd: parseFloat(cost.toFixed(4)),
    };
  });
  return {
    date: today,
    total: { messages: totalMessages, tokens_in: totalIn, tokens_out: totalOut, cost_usd: parseFloat(totalCost.toFixed(4)) },
    breakdown: items,
  };
}

module.exports = {
  getTodayCostUsd, getCap, checkCap,
  getTodayBreakdown, costFor, rateFor,
  COST_INPUT_PER_M, COST_OUTPUT_PER_M,
};
