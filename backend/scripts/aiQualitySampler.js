// Weekly: sample 50 AI messages from last 7d, score via LLM-as-judge.
// Detect quality drift before customers complain.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const aiClient = require('../services/aiClient');
const logger = require('../services/logger');

const SAMPLE_SIZE = parseInt(process.env.AI_QUALITY_SAMPLE_SIZE) || 50;

async function scoreOne(m, conv) {
  const transcript = m.history.map((h) =>
    `${h.direction === 'in' ? 'Customer' : (h.sender_type === 'ai' ? 'AI' : 'Op')}: ${(h.body || '').slice(0, 200)}`
  ).join('\n');

  const prompt = `Kamu reviewer kualitas AI customer service untuk Prestisa (toko bunga online).

Berikut percakapan dan reply AI yang harus di-score. Score 1-5 untuk:
- relevance: apakah reply menjawab pertanyaan customer? (1=tidak nyambung, 5=tepat sasaran)
- tone: apakah tone sopan, ramah, sesuai persona "Tiara"? (1=kasar/robotic, 5=natural & ramah)
- factual: apakah info yang disebutkan benar (harga, kebijakan, lead time)? (1=banyak halusinasi, 5=akurat)

Output WAJIB JSON: {"relevance": N, "tone": N, "factual": N, "reasoning": "1-2 kalimat"}

=== TRANSKRIP (10 pesan terakhir) ===
${transcript}
=== REPLY YANG DI-SCORE ===
${m.body}
=== END ===`;

  try {
    const r = await aiClient.generateWithTools({
      systemPrompt: 'Kamu reviewer netral. Output JSON valid saja, no preamble.',
      messages: [{ role: 'user', content: prompt }],
      tools: [], executor: async () => ({}), maxIterations: 1,
    });
    const text = (r.text || '').trim();
    const jsonMatch = text.match(/\{[\s\S]+\}/);
    if (!jsonMatch) throw new Error('no JSON in judge output');
    const parsed = JSON.parse(jsonMatch[0]);
    const overall = ((parsed.relevance + parsed.tone + parsed.factual) / 3).toFixed(2);
    return { ...parsed, overall, judge_model: r.metadata?.model || 'unknown' };
  } catch (err) {
    logger.warn({ err: err.message, msg_id: m.id }, '[quality] judge failed');
    return null;
  }
}

async function run() {
  // Sample AI replies from last 7d that haven't been scored yet
  const { rows: candidates } = await pg.query(
    `SELECT m.id, m.body, m.conversation_id, m.created_at
     FROM crm_messages m
     LEFT JOIN crm_ai_quality_scores s ON s.message_id = m.id
     WHERE m.sender_type = 'ai' AND m.shadow = FALSE
       AND m.created_at > now() - interval '7 days'
       AND s.id IS NULL
       AND char_length(m.body) > 20
     ORDER BY random() LIMIT $1`,
    [SAMPLE_SIZE]
  );
  if (!candidates.length) { logger.info('[quality] no candidates'); await pg.end(); return; }
  logger.info({ count: candidates.length }, '[quality] scoring');

  const passed = [];
  for (const m of candidates) {
    const { rows: history } = await pg.query(
      `SELECT direction, sender_type, body FROM crm_messages
       WHERE conversation_id = $1 AND id < $2
       ORDER BY id DESC LIMIT 10`,
      [m.conversation_id, m.id]
    );
    m.history = history.reverse();
    const score = await scoreOne(m);
    if (!score) continue;
    await pg.query(
      `INSERT INTO crm_ai_quality_scores (message_id, conversation_id, judge_model, relevance, tone, factual, overall, reasoning)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [m.id, m.conversation_id, score.judge_model, score.relevance, score.tone, score.factual, score.overall, score.reasoning]
    );
    passed.push(score);
  }
  const avg = passed.length ? (passed.reduce((s, p) => s + Number(p.overall), 0) / passed.length).toFixed(2) : 0;
  logger.info({ scored: passed.length, avg_overall: avg }, '[quality] done');
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[quality] failed'); process.exit(1); });
}

module.exports = { run };
