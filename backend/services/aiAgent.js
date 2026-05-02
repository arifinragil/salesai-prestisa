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
  // Pick the LATEST matured job per conversation (newest message_id) so we reply
  // to the freshest message in the burst. process_after gating ensures we wait
  // out the debounce window.
  // Pick the highest message_id pending job (= newest message in any conv's
  // burst). The debounce window already coalesces siblings, and we explicitly
  // mark older pending siblings of the same conversation as skipped below so
  // the burst becomes a single reply.
  const r = await client.query(
    `SELECT id, message_id, conversation_id
     FROM crm_inbound_queue
     WHERE status = 'pending' AND process_after <= now()
     ORDER BY message_id DESC
     FOR UPDATE SKIP LOCKED
     LIMIT 1`
  );
  if (!r.rows[0]) return null;
  const job = r.rows[0];
  // Mark earlier siblings of the same conversation as skipped — they are
  // batched into this job's reply via history.
  await client.query(
    `UPDATE crm_inbound_queue
       SET status = 'skipped', locked_at = now(), locked_by = $2
       WHERE conversation_id = $1 AND status = 'pending' AND id <> $3`,
    [job.conversation_id, workerId, job.id]
  );
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
  // #7 Auto-generate brief asynchronously (don't block worker).
  // Operator akan lihat brief muncul beberapa detik kemudian di /ai-monitor.
  setImmediate(async () => {
    try {
      const briefSvc = require('./handoverBrief');
      const brief = await briefSvc.generateBrief(convId, reason);
      if (brief) {
        await pg.query(`UPDATE crm_handovers SET brief = $2 WHERE id = $1`, [r.rows[0].id, brief]);
        const io = require('./notify').getIO?.();
        if (io) io.to('crm:inbox').emit('crm:handover-brief', { handover_id: r.rows[0].id, brief });
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[handover-brief] async gen failed');
    }
    // #11 + #12 — also extract facts and classify escalation reason on handover
    try {
      const facts = require('./factsExtractor');
      await facts.extract(pg, { convId, customerId: null });
    } catch {}
    try {
      const escClass = require('./escalationClassifier');
      const cls = await escClass.classify(pg, { convId });
      if (cls) await pg.query(`UPDATE crm_handovers SET escalation_class = $2 WHERE id = $1`, [r.rows[0].id, cls]);
    } catch {}
  });
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
    // #8 Snoozed — operator parked the conv. Re-queue to wake-up time.
    if (conv.snoozed_until && new Date(conv.snoozed_until) > new Date()) {
      await client.query(
        `UPDATE crm_inbound_queue SET status = 'pending', process_after = $2, locked_at = NULL, locked_by = NULL WHERE id = $1`,
        [job.id, conv.snoozed_until]
      );
      return { ok: true, snoozed: true, conversation_id: conv.id, retry_at: conv.snoozed_until };
    }

    const msg = await loadMessage(client, job.message_id);
    if (!msg) {
      await markJob(client, job.id, 'failed', 'message_missing');
      return { ok: false, error: 'message_missing' };
    }

    // ── Anti-ban hygiene (humanize bot signature) ────────────────────────
    // 1. Mark inbound message as read on WhatsApp (auto seen)
    waClient.sendSeen({
      phone: conv.phone,
      messageId: msg.waha_message_id,
      session: conv.wa_session,
    }).catch(() => {});

    // 1a. Opt-out detection. Customer ketik STOP/BERHENTI dll → AI permanent off.
    // Compliance + reduce block-rate signal. Send 1 confirmation, no further AI.
    const inboundLower = (msg.body || '').toLowerCase().trim();
    const OPTOUT_PATTERNS = /^(stop|berhenti|unsubscribe|jangan kirim lagi|jangan hubungi lagi|jgn kirim lagi|stop spam)\.?!?$/i;
    if (OPTOUT_PATTERNS.test(inboundLower)) {
      await client.query(
        `UPDATE crm_conversations SET ai_enabled = FALSE, ai_paused_until = now() + interval '1 year', updated_at = now() WHERE id = $1`,
        [conv.id]
      );
      const confirmText = 'Baik Kak, kami berhenti kirim pesan otomatis ke nomor ini. Kalau butuh bantuan lagi, tim Prestisa siap. Terima kasih 🙏';
      try {
        const sent = await waClient.sendText({ phone: conv.phone, text: confirmText, session: conv.wa_session });
        await client.query(
          `INSERT INTO crm_messages (conversation_id, direction, sender_type, body, message_type, send_status, waha_message_id)
           VALUES ($1, 'out', 'system', $2, 'text', 'sent', $3)`,
          [conv.id, confirmText, sent?.id || null]
        );
      } catch (err) { logger.warn({ err: err.message }, '[aiAgent] optout confirm send failed'); }
      const hoId = await recordHandover(client, {
        convId: conv.id, msgId: msg.id, reason: 'other',
        summary: 'opt-out: customer requested AI stop',
      });
      await markJob(client, job.id, 'done');
      notify.notifyHandover({ conversation_id: conv.id, reason: 'opt_out', summary: `customer ketik "${msg.body.slice(0, 40)}"` });
      logger.info({ convId: conv.id }, '[aiAgent] opt-out detected — AI disabled');
      return { ok: true, opt_out: true, handover_id: hoId, conversation_id: conv.id };
    }

    // 1b. Quiet hours — di luar jam kerja CS, queue tetap jalan tapi reply
    // tertunda sampai pagi (jangan ngebot jam 3 pagi).
    const quietStart = parseInt(process.env.WA_QUIET_START_HOUR);
    const quietEnd = parseInt(process.env.WA_QUIET_END_HOUR);
    if (Number.isFinite(quietStart) && Number.isFinite(quietEnd)) {
      // Use Asia/Jakarta wall-clock hour
      const nowHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jakarta', hour: '2-digit', hour12: false }).format(new Date()));
      const isQuiet = quietStart < quietEnd
        ? (nowHour >= quietStart && nowHour < quietEnd)
        : (nowHour >= quietStart || nowHour < quietEnd); // wraps midnight
      if (isQuiet) {
        // Push the job's process_after to the next quietEnd boundary instead of marking done
        const nextWindowStart = (() => {
          const d = new Date();
          // Compute Jakarta-local date and roll to quietEnd
          const jakartaOffset = 7 * 60; // WIB +07:00
          const localMs = d.getTime() + jakartaOffset * 60_000;
          const local = new Date(localMs);
          local.setUTCHours(quietEnd, 5, 0, 0); // 5 min past quiet-end as buffer
          if (local.getTime() <= localMs) local.setUTCDate(local.getUTCDate() + 1);
          return new Date(local.getTime() - jakartaOffset * 60_000);
        })();
        await client.query(
          `UPDATE crm_inbound_queue SET status = 'pending', process_after = $2, locked_at = NULL, locked_by = NULL WHERE id = $1`,
          [job.id, nextWindowStart]
        );
        logger.info({ convId: conv.id, nextWindowStart }, '[aiAgent] quiet hours — re-queued');
        return { ok: true, quiet_hours: true, conversation_id: conv.id, retry_at: nextWindowStart };
      }
    }

    // 1c. Set presence to 'available' (online dot). WAHA persists for ~30s,
    // calling on every job effectively keeps online during active hours.
    waClient.setPresence({ session: conv.wa_session, presence: 'available' }).catch(() => {});

    // 2. Hourly send-rate cap per WA session — kalau lewat batas, handover.
    // In warmup mode (new number, first 7-14 days), drastically lower the caps
    // to avoid early flag.
    const isWarmup = String(process.env.WA_WARMUP_MODE || '').toLowerCase() === 'true';
    const hourCap = isWarmup
      ? (parseInt(process.env.WA_SEND_HOURLY_CAP_WARMUP) || 15)
      : (parseInt(process.env.WA_SEND_HOURLY_CAP) || 60);
    const sentLastHour = await client.query(
      `SELECT COUNT(*)::int AS n FROM crm_messages m
       JOIN crm_conversations c ON c.id = m.conversation_id
       WHERE m.direction = 'out' AND m.sender_type IN ('ai','staff','system')
         AND m.shadow = FALSE
         AND m.created_at > now() - interval '1 hour'
         AND ($2::text IS NULL OR c.wa_session = $2)`,
      [null, conv.wa_session]
    );
    if (sentLastHour.rows[0].n >= hourCap) {
      const hoId = await recordHandover(client, {
        convId: conv.id, msgId: msg.id, reason: 'other',
        summary: `hourly_send_cap: ${sentLastHour.rows[0].n}/${hourCap} per ${conv.wa_session || 'session'}`,
      });
      // Don't send anything — going silent is safer than a "kami sibuk" message
      // that itself counts toward the cap and looks bot-like.
      await markJob(client, job.id, 'done');
      notify.notifyHandover({
        conversation_id: conv.id, reason: 'rate_limit',
        summary: `Hit ${hourCap} sends/hour cap on ${conv.wa_session || 'session'}`,
      });
      logger.warn({ convId: conv.id, sent: sentLastHour.rows[0].n, cap: hourCap }, '[aiAgent] hourly send cap reached — silent handover');
      return { ok: true, handover: true, handover_id: hoId, handover_reason: 'rate_limit', conversation_id: conv.id };
    }

    // 2b. Daily send-rate cap per WA session
    const dailyCap = isWarmup
      ? (parseInt(process.env.WA_SEND_DAILY_CAP_WARMUP) || 60)
      : (parseInt(process.env.WA_SEND_DAILY_CAP) || 300);
    const sentToday = await client.query(
      `SELECT COUNT(*)::int AS n FROM crm_messages m
       JOIN crm_conversations c ON c.id = m.conversation_id
       WHERE m.direction = 'out' AND m.sender_type IN ('ai','staff','system')
         AND m.shadow = FALSE
         AND m.created_at::date = current_date
         AND ($2::text IS NULL OR c.wa_session = $2)`,
      [null, conv.wa_session]
    );
    if (sentToday.rows[0].n >= dailyCap) {
      const hoId = await recordHandover(client, {
        convId: conv.id, msgId: msg.id, reason: 'other',
        summary: `daily_send_cap: ${sentToday.rows[0].n}/${dailyCap} per ${conv.wa_session || 'session'}`,
      });
      await markJob(client, job.id, 'done');
      notify.notifyHandover({
        conversation_id: conv.id, reason: 'rate_limit_daily',
        summary: `Hit ${dailyCap} sends/day cap on ${conv.wa_session || 'session'}`,
      });
      logger.warn({ convId: conv.id, sent: sentToday.rows[0].n, cap: dailyCap }, '[aiAgent] daily send cap reached');
      return { ok: true, handover: true, handover_id: hoId, handover_reason: 'rate_limit_daily', conversation_id: conv.id };
    }

    // 3. Start typing indicator while we generate (visual humanization)
    waClient.startTyping({ phone: conv.phone, session: conv.wa_session }).catch(() => {});

    // Non-text inbound handling:
    //  - image: feed to Claude vision (handled later when building messages)
    //  - voice/audio: transcribe via Whisper, then continue with text
    //  - other (file/document/etc): handover
    let imageForVision = null;
    if (msg.message_type && msg.message_type !== 'text') {
      const t = msg.message_type.toLowerCase();
      const isImage = ['image','jpeg','jpg','png','webp','gif'].includes(t);
      const isVoice = ['voice','audio','ptt','ogg','opus','mp3','m4a','wav'].includes(t);
      if (isImage && msg.attachment_url) {
        imageForVision = msg.attachment_url;
        if (!msg.body || !msg.body.trim()) {
          msg.body = '[Customer mengirim foto. Lihat gambar dan respons natural — tanya konteks/maksud, atau jelaskan jika ini referensi rangkaian.]';
        }
      } else if (isVoice && msg.attachment_url) {
        try {
          const whisper = require('./whisperTranscribe');
          const lang = conv.detected_language || 'id';
          const tr = await whisper.transcribe(msg.attachment_url, lang);
          if (tr.text) {
            msg.body = `[suara] ${tr.text}`;
            await client.query(`UPDATE crm_messages SET body = $2 WHERE id = $1`, [msg.id, msg.body]);
          } else {
            throw new Error('empty transcript');
          }
        } catch (err) {
          logger.warn({ err: err.message, msgId: msg.id }, '[aiAgent] voice transcribe failed → handover');
          const hoId = await recordHandover(client, { convId: conv.id, msgId: msg.id, reason: 'other', summary: `voice transcribe failed: ${err.message}` });
          await sendSafeHandoverReply(client, conv);
          await markJob(client, job.id, 'done');
          notify.notifyHandover({ conversation_id: conv.id, reason: 'other', summary: 'voice note (transcribe gagal)' });
          return { ok: true, handover: true, handover_id: hoId, handover_reason: 'voice_failed', conversation_id: conv.id };
        }
      } else {
        const hoId = await recordHandover(client, { convId: conv.id, msgId: msg.id, reason: 'other', summary: `non-text inbound: ${msg.message_type}` });
        await sendSafeHandoverReply(client, conv);
        await markJob(client, job.id, 'done');
        notify.notifyHandover({ conversation_id: conv.id, reason: 'other', summary: `non-text: ${msg.message_type}` });
        return { ok: true, handover: true, handover_id: hoId, handover_reason: 'non_text', conversation_id: conv.id };
      }
    }

    const inboundText = (msg.body || '').toString().trim();
    if (!inboundText) {
      await markJob(client, job.id, 'skipped', 'empty_inbound');
      return { ok: true, skipped: 'empty_inbound', conversation_id: conv.id };
    }

    // #14 + #20 PII detect AND scrub-write for high-sensitivity (card/nik/cvv)
    const piiScrubber = require('./piiScrubber');
    const piiFlags = piiScrubber.detect(inboundText);
    if (Object.keys(piiFlags).length) {
      const sensitive = piiFlags.card || piiFlags.nik || piiFlags.cvv;
      if (sensitive) {
        const { text: scrubbed } = piiScrubber.redact(inboundText);
        await client.query(`UPDATE crm_messages SET body = $2, pii_flags = $3 WHERE id = $1`, [msg.id, scrubbed, piiFlags]);
        msg.body = scrubbed;
      } else {
        await client.query(`UPDATE crm_messages SET pii_flags = $2 WHERE id = $1`, [msg.id, piiFlags]);
      }
    }

    // #16 Multi-language detect (cheap heuristic) — persist & inject in persona
    try {
      const langDetect = require('./langDetect');
      const lang = langDetect.detect(inboundText);
      if (lang && lang !== conv.detected_language) {
        await client.query(`UPDATE crm_conversations SET detected_language = $2 WHERE id = $1`, [conv.id, lang]);
        conv.detected_language = lang;
      }
    } catch {}

    // #12 Sentiment classification (cheap regex)
    const sentimentInline = require('./sentimentInline');
    const sentiment = sentimentInline.classify(inboundText);
    if (sentiment) {
      await client.query(`UPDATE crm_messages SET sentiment = $2 WHERE id = $1`, [msg.id, sentiment]);
    }
    // If angry → fast-track handover, skip AI (don't antagonize further)
    if (sentiment === 'angry') {
      const hoId = await recordHandover(client, {
        convId: conv.id, msgId: msg.id, reason: 'angry',
        summary: `Angry sentiment detected — fast handover`,
      });
      await sendSafeHandoverReply(client, conv);
      await markJob(client, job.id, 'done');
      notify.notifyHandover({ conversation_id: conv.id, reason: 'angry', summary: inboundText.slice(0, 80) });
      return { ok: true, handover: true, handover_id: hoId, conversation_id: conv.id, sentiment };
    }

    // #13 Repeat-question detector — AI keeps failing same Q → handover
    const repeatDetector = require('./repeatDetector');
    if (await repeatDetector.isRepeatedQuestion(client, conv.id, inboundText)) {
      const hoId = await recordHandover(client, {
        convId: conv.id, msgId: msg.id, reason: 'low_confidence',
        summary: 'Repeat question — AI failing to satisfy',
      });
      await sendSafeHandoverReply(client, conv);
      await markJob(client, job.id, 'done');
      notify.notifyHandover({ conversation_id: conv.id, reason: 'repeat_question', summary: inboundText.slice(0, 80) });
      return { ok: true, handover: true, handover_id: hoId, conversation_id: conv.id, repeat: true };
    }

    const cls = await gemini.classifyIntent(inboundText);
    logger.info({ convId: conv.id, intent: cls.intent, confidence: cls.confidence }, '[aiAgent] pre-classified');

    // #10 Topic auto-tag — best-effort, non-blocking on failure
    try {
      if (cls.intent && cls.confidence >= 0.5) {
        const topicTagger = require('./topicTagger');
        await topicTagger.attach(client, conv.id, cls.intent);
      }
    } catch {}

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

    // #18 Image vision — replace last user content with multimodal blocks (Claude only).
    if (imageForVision) {
      try {
        const status = await aiClient.getActiveStatus().catch(() => ({ provider: null }));
        if (status.provider === 'anthropic' || status.provider === 'claude') {
          const last = messages[messages.length - 1];
          last.content = [
            { type: 'image', source: { type: 'url', url: imageForVision } },
            { type: 'text', text: inboundText },
          ];
        } else {
          logger.info({ provider: status.provider }, '[aiAgent] image inbound but provider not claude — text-only fallback');
        }
      } catch (err) {
        logger.warn({ err: err.message }, '[aiAgent] vision attach failed (continuing text-only)');
      }
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
      try {
        const kbDraftBuilder = require('./kbDraftBuilder');
        await kbDraftBuilder.capture(client, { convId: conv.id, msgId: msg.id, question: inboundText, reason: 'low_confidence' });
      } catch {}
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

    // Anti-bot: random "thinking time" before send. Long messages = longer
    // delay (humans type slower). Floor 2s, ceil 9s.
    const minDelay = parseInt(process.env.WA_MIN_REPLY_DELAY_MS) || 2000;
    const maxDelay = parseInt(process.env.WA_MAX_REPLY_DELAY_MS) || 9000;
    const lenFactor = Math.min(1, llm.text.length / 200); // longer text → closer to max
    const targetDelay = minDelay + (maxDelay - minDelay) * (0.4 + 0.6 * lenFactor);
    const jitter = (Math.random() - 0.5) * 1000;
    const elapsed = Date.now() - startedAt;
    const waitMs = Math.max(0, Math.round(targetDelay + jitter - elapsed));
    if (waitMs > 0) await new Promise((res) => setTimeout(res, waitMs));

    // Stop typing right before send (so the user sees "typing…" disappear → message)
    waClient.stopTyping({ phone: conv.phone, session: conv.wa_session }).catch(() => {});

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
