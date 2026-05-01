const pg = require('../db/postgres');
const waClient = require('./waClient');
const aiClient = require('./aiClient');
const gemini = require('./geminiClient');
const tools = require('./aiTools');
const persona = require('./aiPersona');
const guardrails = require('./aiGuardrails');
const confidence = require('./aiConfidence');
const notify = require('./notify');
const logger = require('./logger');
const costGuard = require('./costGuard');
const { resolveByPhone } = require('./contactResolver');

const SAFE_HANDOVER_REPLY = 'Sebentar Kak, aku panggilkan tim ya. Tim Prestisa segera bantu jawab.';
const HISTORY_LIMIT = 20;

function isAiGloballyEnabled() {
  return String(process.env.AI_GLOBAL_ENABLED || 'true').toLowerCase() !== 'false';
}

async function claimNextJob(client, workerId) {
  const r = await client.query(
    `SELECT id, message_id, conversation_id
     FROM crm_inbound_queue
     WHERE status = 'pending'
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1`
  );
  if (!r.rows[0]) return null;
  const job = r.rows[0];
  await client.query(
    `UPDATE crm_inbound_queue
       SET status = 'processing', locked_at = now(), locked_by = $2, attempts = attempts + 1
       WHERE id = $1`,
    [job.id, workerId]
  );
  return job;
}

async function loadConv(client, convId) {
  const r = await client.query(`SELECT * FROM crm_conversations WHERE id = $1`, [convId]);
  return r.rows[0];
}

async function loadMessage(client, msgId) {
  const r = await client.query(`SELECT * FROM crm_messages WHERE id = $1`, [msgId]);
  return r.rows[0];
}

async function loadHistory(client, convId) {
  const r = await client.query(
    `SELECT direction, sender_type, body
     FROM crm_messages
     WHERE conversation_id = $1
     ORDER BY id DESC LIMIT $2`,
    [convId, HISTORY_LIMIT]
  );
  return r.rows.reverse();
}

async function recordOutbound(client, { convId, body, sentMsgId, sendStatus, shadow, metadata }) {
  const r = await client.query(
    `INSERT INTO crm_messages
       (conversation_id, direction, sender_type, body, message_type, send_status, shadow, ai_metadata, waha_message_id)
     VALUES ($1, 'out', 'ai', $2, 'text', $3, $4, $5, $6)
     RETURNING id, created_at`,
    [convId, body, sendStatus, !!shadow, metadata ? JSON.stringify(metadata) : null, sentMsgId || null]
  );
  await client.query(
    `UPDATE crm_conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`,
    [convId]
  );
  return r.rows[0];
}

// Reasons that REQUIRE human intervention — pause AI 24h (operator must resume).
// Auto-classifier failures don't pause: if next customer msg is fine, AI retries
// naturally; if same issue repeats, it handover again — cost cap protects budget.
const HUMAN_REQUIRED_REASONS = new Set([
  'complaint', 'refund', 'cancel', 'legal', 'angry',
  'explicit_request_human', 'custom_price', 'manual_takeover',
]);

async function recordHandover(client, { convId, msgId, reason, summary, pauseHours }) {
  const r = await client.query(
    `INSERT INTO crm_handovers (conversation_id, message_id, reason, detail) VALUES ($1, $2, $3, $4) RETURNING id`,
    [convId, msgId || null, reason, summary || null]
  );
  // Decide pause: explicit pauseHours wins; else by reason category.
  const hours = pauseHours != null
    ? pauseHours
    : (HUMAN_REQUIRED_REASONS.has(reason) ? 24 : 0);

  if (hours > 0) {
    await client.query(
      `UPDATE crm_conversations
         SET ai_paused_until = now() + ($2 || ' hours')::interval,
             handover_count = handover_count + 1,
             updated_at = now()
       WHERE id = $1`,
      [convId, String(hours)]
    );
  } else {
    // Bump handover_count but don't pause AI — let next message retry naturally
    await client.query(
      `UPDATE crm_conversations
         SET handover_count = handover_count + 1, updated_at = now()
       WHERE id = $1`,
      [convId]
    );
  }
  return r.rows[0].id;
}

async function markJob(client, jobId, status, error) {
  await client.query(
    `UPDATE crm_inbound_queue
       SET status = $2, processed_at = now(), error = $3
       WHERE id = $1`,
    [jobId, status, error || null]
  );
}

async function sendSafeHandoverReply(_client, conv) {
  if (conv.shadow_mode) return;
  try {
    await waClient.sendText({ phone: conv.phone, text: SAFE_HANDOVER_REPLY });
  } catch (err) {
    logger.warn({ err: err.message, convId: conv.id }, '[aiAgent] safe handover reply send failed');
  }
}

async function processOne() {
  const workerId = process.env.WORKER_ID || `worker-${process.pid}`;
  const client = await pg.connect();
  let job;
  try {
    await client.query('BEGIN');
    job = await claimNextJob(client, workerId);
    if (!job) {
      await client.query('COMMIT');
      client.release();
      return { ok: true, idle: true };
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    client.release();
    logger.error({ err: err.message }, '[aiAgent] claim failed');
    return { ok: false, error: err.message };
  }

  const startedAt = Date.now();
  try {
    if (!isAiGloballyEnabled()) {
      await markJob(client, job.id, 'skipped', 'ai_disabled_global');
      return { ok: true, skipped: 'ai_disabled_global', conversation_id: job.conversation_id };
    }

    const conv = await loadConv(client, job.conversation_id);
    if (!conv) {
      await markJob(client, job.id, 'failed', 'conversation_missing');
      return { ok: false, error: 'conversation_missing' };
    }

    if (conv.ai_paused_until && new Date(conv.ai_paused_until) > new Date()) {
      await markJob(client, job.id, 'skipped', 'paused');
      return { ok: true, skipped: 'paused', conversation_id: conv.id };
    }
    if (!conv.ai_enabled) {
      await markJob(client, job.id, 'skipped', 'ai_disabled_conv');
      return { ok: true, skipped: 'ai_disabled_conv', conversation_id: conv.id };
    }

    const msg = await loadMessage(client, job.message_id);
    if (!msg) {
      await markJob(client, job.id, 'failed', 'message_missing');
      return { ok: false, error: 'message_missing' };
    }

    if (msg.message_type && msg.message_type !== 'text') {
      const hoId = await recordHandover(client, { convId: conv.id, msgId: msg.id, reason: 'other', summary: `non-text inbound: ${msg.message_type}` });
      await sendSafeHandoverReply(client, conv);
      await markJob(client, job.id, 'done');
      notify.notifyHandover({ conversation_id: conv.id, reason: 'other', summary: `non-text: ${msg.message_type}` });
      return { ok: true, handover: true, handover_id: hoId, handover_reason: 'non_text', conversation_id: conv.id };
    }

    const inboundText = (msg.body || '').toString().trim();
    if (!inboundText) {
      await markJob(client, job.id, 'skipped', 'empty_inbound');
      return { ok: true, skipped: 'empty_inbound', conversation_id: conv.id };
    }

    const cls = await gemini.classifyIntent(inboundText);
    logger.info({ convId: conv.id, intent: cls.intent, confidence: cls.confidence }, '[aiAgent] pre-classified');

    if (gemini.isDangerous(cls.intent)) {
      const hoReason = cls.intent === 'explicit_request_human' ? 'explicit_request_human' : cls.intent;
      const hoId = await recordHandover(client, { convId: conv.id, msgId: msg.id, reason: hoReason, summary: `intent=${cls.intent}` });
      await sendSafeHandoverReply(client, conv);
      await client.query(`UPDATE crm_conversations SET last_intent = $2 WHERE id = $1`, [conv.id, cls.intent]);
      await markJob(client, job.id, 'done');
      notify.notifyHandover({ conversation_id: conv.id, reason: cls.intent, summary: `pre-classifier flagged ${cls.intent}` });
      return { ok: true, handover: true, handover_id: hoId, handover_reason: cls.intent, conversation_id: conv.id };
    }

    // Cost cap check (per spec §15 risk #3): if today's accumulated cost
    // already exceeds the configured cap, skip Claude and handover.
    let cap;
    try { cap = await costGuard.checkCap(); } catch (err) {
      logger.warn({ err: err.message }, '[aiAgent] cost cap check failed (continuing)');
    }
    if (cap && cap.overCap) {
      const hoId = await recordHandover(client, {
        convId: conv.id, msgId: msg.id, reason: 'other',
        summary: `cost_cap_reached: $${cap.current.toFixed(4)} >= $${cap.cap}`,
      });
      await sendSafeHandoverReply(client, conv);
      await markJob(client, job.id, 'done');
      notify.notifyHandover({ conversation_id: conv.id, reason: 'cost_cap_reached', summary: `today $${cap.current.toFixed(2)} / cap $${cap.cap}` });
      logger.warn({ current: cap.current, cap: cap.cap }, '[aiAgent] daily cost cap reached — handover');
      return { ok: true, handover: true, handover_id: hoId, handover_reason: 'cost_cap_reached', conversation_id: conv.id };
    }

    const resolved = await resolveByPhone(conv.phone);
    const systemPrompt = await persona.buildSystemPrompt({
      conv, customerName: resolved.name, cityHint: null,
    });
    const history = await loadHistory(client, conv.id);
    const messages = persona.buildHistoryMessages(history);
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      messages.push({ role: 'user', content: inboundText });
    }

    const exec = (name, args) => {
      const fn = tools.executors[name];
      if (!fn) return Promise.resolve({ error: `unknown tool ${name}` });
      return Promise.resolve(fn({ args, conv, customer_id: conv.customer_id, phone: conv.phone }));
    };

    let llm;
    try {
      llm = await aiClient.generateWithTools({
        systemPrompt, messages, tools: tools.declarations, executor: exec, maxIterations: 5,
      });
    } catch (err) {
      logger.error({ err: err.message, convId: conv.id }, '[aiAgent] claude failed');
      const hoId = await recordHandover(client, { convId: conv.id, msgId: msg.id, reason: 'tool_error', summary: `claude error: ${err.message}` });
      await sendSafeHandoverReply(client, conv);
      await markJob(client, job.id, 'failed', err.message);
      notify.notifyHandover({ conversation_id: conv.id, reason: 'tool_error', summary: err.message });
      return { ok: false, handover: true, handover_id: hoId, handover_reason: 'ai_unavailable' };
    }

    const latencyMs = Date.now() - startedAt;
    const activeStatus = await aiClient.getActiveStatus().catch(() => ({ provider: 'unknown', model: '?' }));
    const baseMeta = {
      provider: activeStatus.provider,
      model: activeStatus.model,
      latency_ms: latencyMs,
      tokens_in: llm.usage.input_tokens,
      tokens_out: llm.usage.output_tokens,
      tools_called: llm.calls.map((c) => c.name),
      intent: cls.intent,
      intent_confidence: cls.confidence,
    };

    if (llm.iterationsCapped) {
      const hoId = await recordHandover(client, { convId: conv.id, msgId: msg.id, reason: 'tool_error', summary: 'iteration cap reached' });
      await sendSafeHandoverReply(client, conv);
      await markJob(client, job.id, 'done');
      notify.notifyHandover({ conversation_id: conv.id, reason: 'iteration_cap', summary: 'iteration cap reached' });
      return { ok: true, handover: true, handover_id: hoId, handover_reason: 'iteration_cap', conversation_id: conv.id };
    }

    const toolHandover = llm.calls.find((c) => c.name === 'request_handover' && c.result?.ok);
    if (toolHandover) {
      await sendSafeHandoverReply(client, conv);
      await markJob(client, job.id, 'done');
      notify.notifyHandover({ conversation_id: conv.id, reason: toolHandover.args.reason, summary: toolHandover.args.summary });
      return { ok: true, handover: true, handover_reason: toolHandover.args.reason, conversation_id: conv.id };
    }

    const check = guardrails.checkReply({ reply: llm.text, toolCalls: llm.calls });
    if (!check.passed) {
      const hoId = await recordHandover(client, { convId: conv.id, msgId: msg.id, reason: 'tool_error', summary: `post_check_failed: ${check.reason}` });
      await sendSafeHandoverReply(client, conv);
      await markJob(client, job.id, 'done');
      notify.notifyHandover({ conversation_id: conv.id, reason: 'post_check_failed', summary: check.reason });
      return { ok: true, handover: true, handover_id: hoId, handover_reason: 'post_check_failed', detail: check, conversation_id: conv.id };
    }

    const score = confidence.scoreReply({
      reply: llm.text, toolCalls: llm.calls, intent: cls.intent, iterationsCapped: false,
    });
    if (confidence.shouldEscalate(score)) {
      const hoId = await recordHandover(client, { convId: conv.id, msgId: msg.id, reason: 'low_confidence', summary: `score=${score.toFixed(2)}` });
      await sendSafeHandoverReply(client, conv);
      await markJob(client, job.id, 'done');
      notify.notifyHandover({ conversation_id: conv.id, reason: 'low_confidence', summary: `score ${score.toFixed(2)}` });
      return { ok: true, handover: true, handover_id: hoId, handover_reason: 'low_confidence', score, conversation_id: conv.id };
    }

    const meta = { ...baseMeta, confidence: score };
    if (conv.shadow_mode) {
      const stored = await recordOutbound(client, { convId: conv.id, body: llm.text, sendStatus: null, shadow: true, metadata: meta });
      await markJob(client, job.id, 'done');
      notify.notifyMessage({ conversation_id: conv.id, message: { ...stored, body: llm.text, direction: 'out', sender_type: 'ai', shadow: true } });
      await client.query(`UPDATE crm_conversations SET last_intent = $2 WHERE id = $1`, [conv.id, cls.intent]);
      return { ok: true, shadow: true, conversation_id: conv.id, score };
    }

    let waResult;
    try {
      waResult = await waClient.sendText({ phone: conv.phone, text: llm.text });
    } catch (err) {
      logger.error({ err: err.message, convId: conv.id }, '[aiAgent] waha send failed');
      await recordOutbound(client, { convId: conv.id, body: llm.text, sendStatus: 'send_failed', metadata: { ...meta, send_error: err.message } });
      await markJob(client, job.id, 'failed', `send failed: ${err.message}`);
      return { ok: false, send_failed: true, conversation_id: conv.id, error: err.message };
    }

    const stored = await recordOutbound(client, {
      convId: conv.id, body: llm.text, sentMsgId: waResult.id, sendStatus: 'sent', metadata: meta,
    });
    await client.query(`UPDATE crm_conversations SET last_intent = $2 WHERE id = $1`, [conv.id, cls.intent]);
    await markJob(client, job.id, 'done');

    notify.notifyMessage({ conversation_id: conv.id, message: {
      id: stored.id, body: llm.text, direction: 'out', sender_type: 'ai', created_at: stored.created_at,
    }});

    return { ok: true, sent: true, conversation_id: conv.id, score };
  } catch (err) {
    logger.error({ err: err.message, jobId: job.id }, '[aiAgent] processing failed');
    try {
      await markJob(client, job.id, 'failed', err.message);
    } catch {}
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

let workerStop = false;

async function startWorker() {
  workerStop = false;
  const interval = parseInt(process.env.WORKER_POLL_INTERVAL_MS) || 2000;
  logger.info({ interval }, '[aiAgent] worker starting');
  while (!workerStop) {
    try {
      const r = await processOne();
      if (r.idle) {
        await new Promise((res) => setTimeout(res, interval));
      }
    } catch (err) {
      logger.error({ err: err.message }, '[aiAgent] worker tick error');
      await new Promise((res) => setTimeout(res, interval));
    }
  }
  logger.info('[aiAgent] worker stopped');
}

function stopWorker() { workerStop = true; }

async function reapStaleLocks() {
  const ttl = parseInt(process.env.WORKER_LOCK_TTL_MS) || 300000;
  const r = await pg.query(
    `UPDATE crm_inbound_queue
       SET status = 'pending', locked_at = NULL, locked_by = NULL
       WHERE status = 'processing' AND locked_at < now() - INTERVAL '${Math.floor(ttl / 1000)} seconds'
       RETURNING id`
  );
  if (r.rowCount > 0) logger.warn({ count: r.rowCount }, '[aiAgent] reaped stale locks');
  return r.rowCount;
}

module.exports = { processOne, claimNextJob, startWorker, stopWorker, reapStaleLocks };
