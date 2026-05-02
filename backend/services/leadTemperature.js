// backend/services/leadTemperature.js
// Rule-based lead temperature classifier. Sub-50ms. Per spec section 6.
//
// score = (base + intent + keyword + behavioral) * recency_factor
// score >= 70 → hot; 40..69 → warm; 0..39 → cold
//
// Triggers (called by):
//   - webhook ingest (after spam check)
//   - pipelineEngine.apply (after stage transition)
//   - cron leadTempDecay (recency sweep)

const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const logger = require('./logger');

const HOT_KEYWORDS_JS = [
  /\b(transfer kemana|nomor rek|rekening|VA|bayar dimana|bayar sekarang)\b/i,
  /\b(budget|anggaran)\s*(rp|sekitar)?\s*\d/i,
  /\b(deadline|harus sampai|wajib hari ini|urgent|asap)\b/i,
  /\b(sip|ok|deal|setuju|mau|jadi(?:in)?|fix(?:in)?)\b/i,
  /\b(kapan bisa kirim|siap kirim|delivery besok)\b/i,
];
const WARM_KEYWORDS_JS = [
  /\b(harga|berapa|murah|diskon|promo)\b/i,
  /\b(tersedia|ready|stok|ada ngga|ada|tanggal)\b/i,
  /\b(model|warna|ukuran|pilihan)\b/i,
];

function scoreIntent(intent) {
  if (!intent) return 0;
  switch (intent) {
    case 'order_intent': return 35;
    case 'payment':
    case 'confirm_order': return 30;
    case 'shipping': return 20;
    case 'pricing': return 15;
    case 'order_status': return 10;
    case 'product_info': return 5;
    case 'complaint':
    case 'cancel': return -20;
    default: return 0;
  }
}

function scoreKeywords(body) {
  if (!body) return 0;
  const text = String(body);
  let score = 0;
  for (const re of HOT_KEYWORDS_JS) if (re.test(text)) { score += 15; break; }
  for (const re of WARM_KEYWORDS_JS) if (re.test(text)) { score += 8; break; }
  return Math.min(30, score);
}

function recencyFactor(lastInboundAt) {
  if (!lastInboundAt) return 0.4;
  const minutes = (Date.now() - new Date(lastInboundAt).getTime()) / 60_000;
  const decay = Math.max(0, 1 - minutes / 120);
  return 0.4 + 0.6 * decay;
}

async function loadContext(conversationId) {
  const cQ = await pg.query(
    `SELECT id, customer_id, last_intent, last_message_at, pipeline_stage,
            real_phone, phone
     FROM crm_conversations WHERE id = $1`,
    [conversationId]
  );
  const conv = cQ.rows[0];
  if (!conv) return null;

  const recentMsgsQ = await pg.query(
    `SELECT body, direction, created_at
     FROM crm_messages
     WHERE conversation_id = $1 AND created_at > now() - interval '30 minutes'
     ORDER BY id DESC LIMIT 20`,
    [conversationId]
  );
  const lastInbound = recentMsgsQ.rows.find((m) => m.direction === 'in');
  const inboundCountLast30m = recentMsgsQ.rows.filter((m) => m.direction === 'in').length;

  // Form submitted? — short-circuit signal
  const linkQ = await pg.query(
    `SELECT event FROM crm_link_events
     WHERE conversation_id = $1 AND created_at > now() - interval '24 hours'
     ORDER BY id DESC LIMIT 5`,
    [conversationId]
  );
  const submitted = linkQ.rows.some((e) => e.event === 'submitted');
  const clicked   = linkQ.rows.some((e) => e.event === 'clicked');

  // Past order? (existing customer signal)
  let pastOrder = false;
  if (conv.customer_id) {
    try {
      const [rows] = await mysql.query(
        `SELECT 1 FROM \`order\` WHERE customer_id = ? AND deleted_at IS NULL LIMIT 1`,
        [conv.customer_id]
      );
      pastOrder = rows.length > 0;
    } catch (err) {
      logger.warn({ err: err.message, conv_id: conversationId }, '[leadTemp] mysql past-order lookup failed');
    }
  }

  // Recent lost?
  const lostQ = await pg.query(
    `SELECT 1 FROM crm_pipeline_events
     WHERE conversation_id = $1 AND to_stage = 'lost'
       AND created_at > now() - interval '30 days'
     LIMIT 1`,
    [conversationId]
  );
  const recentLost = lostQ.rows.length > 0;

  return {
    conv,
    lastInbound,
    inboundCountLast30m,
    submitted,
    clicked,
    pastOrder,
    recentLost,
  };
}

function scoreBehavior(ctx) {
  if (ctx.submitted) return null; // sentinel: caller short-circuits to 100/hot
  let s = 0;
  if (ctx.clicked) s += 15;
  if (ctx.inboundCountLast30m >= 3) s += 10;
  if (ctx.pastOrder) s += 10;
  if (ctx.conv.pipeline_stage === 'qualified' || ctx.conv.pipeline_stage === 'proposal_sent') s += 20;
  if (ctx.recentLost) s -= 15;
  return s;
}

function tempFor(score) {
  if (score >= 70) return 'hot';
  if (score >= 40) return 'warm';
  return 'cold';
}

/**
 * Compute and persist lead temperature for a conversation.
 *
 * @param {number} conversationId
 * @param {{ inboundBody?: string, intent?: string }} [opts]  optional fresh signals
 *        from the caller (webhook has them in scope; cron does not)
 * @returns {Promise<{temp:string, score:number, signals:object}>}
 */
async function compute(conversationId, opts = {}) {
  const ctx = await loadContext(conversationId);
  if (!ctx) return { temp: 'cold', score: 0, signals: { error: 'conv_missing' } };

  // Form submitted is a hard signal → max it out.
  if (ctx.submitted) {
    await persist(conversationId, 'hot', 100);
    return { temp: 'hot', score: 100, signals: { submitted: true } };
  }

  const intent = opts.intent || ctx.conv.last_intent || null;
  const inboundBody = opts.inboundBody || ctx.lastInbound?.body || '';

  const intentScore   = scoreIntent(intent);
  const keywordScore  = scoreKeywords(inboundBody);
  const behaviorScore = scoreBehavior(ctx);
  const rawTotal      = intentScore + keywordScore + behaviorScore;
  const recency       = recencyFactor(ctx.lastInbound?.created_at || ctx.conv.last_message_at);
  let score = rawTotal * recency;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const temp = tempFor(score);

  await persist(conversationId, temp, score);

  return {
    temp,
    score,
    signals: {
      intent, intentScore,
      keywordScore, behaviorScore,
      rawTotal, recency: Number(recency.toFixed(3)),
      pipeline: ctx.conv.pipeline_stage,
      pastOrder: ctx.pastOrder,
      clicked: ctx.clicked,
      recentLost: ctx.recentLost,
      inboundCountLast30m: ctx.inboundCountLast30m,
    },
  };
}

async function persist(conversationId, temp, score) {
  await pg.query(
    `UPDATE crm_conversations SET lead_temperature = $2, lead_score = $3 WHERE id = $1`,
    [conversationId, temp, score]
  );
}

module.exports = { compute };
