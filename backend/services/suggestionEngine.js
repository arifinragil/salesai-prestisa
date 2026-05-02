// backend/services/suggestionEngine.js
// Generate 4 reply suggestions for an inbound message:
//   - 3 from case library (relevance-ranked)
//   - 1 AI synthesis via active provider (anthropic / openai / gemini per setting)
// Persist to crm_suggestion_log, return options + log id.
const pg = require('../db/postgres');
const caseLibrary = require('./caseLibrary');
const aiClient = require('./aiClient');
const persona = require('./aiPersona');
const logger = require('./logger');

const AI_TIMEOUT_MS = parseInt(process.env.COPILOT_AI_TIMEOUT_MS) || 4000;

async function lastTurns(conversationId, limit = 5) {
  const r = await pg.query(
    `SELECT direction, sender_type, body, created_at
     FROM crm_messages
     WHERE conversation_id = $1
     ORDER BY id DESC LIMIT $2`,
    [conversationId, limit]
  );
  return r.rows.reverse();
}

function buildAiPrompt({ inboundBody, intent, intentConf, turns, caseOptions }) {
  const transcript = turns.map((t) =>
    `${t.direction === 'in' ? 'Customer' : 'Tiara'}: ${t.body || '(media)'}`
  ).join('\n');
  const cases = caseOptions.map((c, i) => `${i+1}. ${c.body}`).join('\n');
  return `Customer message terbaru: "${inboundBody}"
Intent: ${intent || 'unknown'} (confidence ${intentConf ?? '-'})

Last 5 turns:
${transcript}

3 saran reply (case library):
${cases}

Tugas: tulis 1 reply ALTERNATIF — synthesize/improve dari 3 saran di atas dengan persona Tiara.
Constraint:
- Bahasa Indonesia santai-sopan, sapaan "Kak"
- Max 200 kata
- Kalau 3 saran sudah cover semua angle, tawarkan kombinasi atau tambah CTA (mis. "Mau Tiara siapin link order Kak?")
- Output: HANYA text reply, tanpa preamble, tanpa quote marks, tanpa label.`;
}

async function generateAi({ inboundBody, intent, intentConf, turns, caseOptions }) {
  let sys = '';
  try {
    const p = await persona.loadActivePrompt();
    sys = p?.prompt_text || '';
  } catch { /* no persona seeded — proceed without system prompt */ }

  const t0 = Date.now();
  try {
    const resp = await Promise.race([
      aiClient.complete({
        system: sys,
        messages: [{ role: 'user', content: buildAiPrompt({ inboundBody, intent, intentConf, turns, caseOptions }) }],
        max_tokens: 400,
        temperature: 0.4,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('ai_timeout')), AI_TIMEOUT_MS)),
    ]);
    const text = (resp?.text || '').trim();
    return { text, ms: Date.now() - t0, error: null };
  } catch (err) {
    logger.warn({ err: err.message }, '[suggestion] ai elaboration failed');
    return { text: null, ms: Date.now() - t0, error: err.message };
  }
}

async function generate(opts) {
  const { conversationId, inboundMsgId, inboundBody, intent, intentConf, regen, regenLogId } = opts;
  const t0 = Date.now();

  const [{ items: caseItems, lowConfidence }, turns] = await Promise.all([
    caseLibrary.lookup({ inboundBody, intent }),
    lastTurns(conversationId, 5),
  ]);

  const aiResult = await generateAi({ inboundBody, intent, intentConf, turns, caseOptions: caseItems });

  const options = caseItems.map((c, i) => ({
    rank: i + 1,
    source: 'case',
    template_id: c.id,
    template_shortcut: c.shortcut,
    case_label: c.case_label,
    text: c.body,
    confidence: lowConfidence ? 'low' : 'normal',
  }));
  options.push({
    rank: 4,
    source: aiResult.text ? 'ai' : 'fallback',
    text: aiResult.text || 'Tidak ada usulan AI — gunakan opsi 1-3 atau ketik manual.',
    confidence: aiResult.text ? (lowConfidence ? 'low' : 'normal') : 'low',
    ai_ms: aiResult.ms,
    ai_error: aiResult.error,
  });

  const generationMs = Date.now() - t0;

  let logId;
  if (regen && regenLogId) {
    const r = await pg.query(
      `UPDATE crm_suggestion_log
       SET options = $1, generation_ms = $2, shown_at = now(),
           regen_count = regen_count + 1
       WHERE id = $3 RETURNING id`,
      [JSON.stringify(options), generationMs, regenLogId]
    );
    logId = r.rows[0]?.id;
  } else {
    const r = await pg.query(
      `INSERT INTO crm_suggestion_log
         (conversation_id, inbound_msg_id, options, generation_ms)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [conversationId, inboundMsgId, JSON.stringify(options), generationMs]
    );
    logId = r.rows[0].id;
  }

  return {
    log_id: logId,
    options,
    generation_ms: generationMs,
    low_confidence_warning: lowConfidence,
  };
}

module.exports = { generate };
