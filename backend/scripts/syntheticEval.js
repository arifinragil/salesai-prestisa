// #13 Synthetic eval — weekly Sunday 04:00 WIB.
// For each active synthetic Q, run aiAgent classifier+reply in shadow mode
// (no DB persist of conv), then judge reply quality via LLM-as-judge.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const aiClient = require('../services/aiClient');
const persona = require('../services/aiPersona');
const tools = require('../services/aiTools');
const gemini = require('../services/geminiClient');
const logger = require('../services/logger');

async function judge(question, expected, reply, intent) {
  const prompt = `Soal customer simulasi: "${question}"
Intent yang seharusnya: ${expected}
Intent terdeteksi: ${intent}
Reply AI: "${reply}"

Score 1-5 (1=sangat buruk, 5=sempurna). Pertimbangkan: relevansi, akurasi (tidak halusinasi harga/kebijakan), tone Tiara (santai-sopan, sapaan Kak), call-to-action.

Output JSON: {"score": N, "reasoning": "1 kalimat"}.`;
  try {
    const r = await aiClient.generateWithTools({
      systemPrompt: 'Kamu reviewer netral. Output JSON valid saja.',
      messages: [{ role: 'user', content: prompt }],
      tools: [], executor: async () => ({}), maxIterations: 1,
    });
    const m = (r.text || '').match(/\{[\s\S]+\}/);
    if (!m) return { score: 0, reasoning: 'no JSON' };
    return JSON.parse(m[0]);
  } catch (err) { return { score: 0, reasoning: 'judge error: ' + err.message }; }
}

async function runOne(q) {
  const fakeConv = { id: 0, phone: '628000000000', customer_id: null, last_intent: null };
  const cls = await gemini.classifyIntent(q.question);
  if (gemini.isDangerous(cls.intent)) {
    return { questionId: q.id, intent: cls.intent, reply: '[handover early]', score: 5, reasoning: 'correctly handover' };
  }
  const systemPrompt = await persona.buildSystemPrompt({ conv: fakeConv, customerName: null, cityHint: null });
  const exec = (name, args) => {
    const fn = tools.executors[name];
    if (!fn) return Promise.resolve({ error: `unknown ${name}` });
    return Promise.resolve(fn({ args, conv: fakeConv, customer_id: null, phone: fakeConv.phone }));
  };
  let llm;
  try {
    llm = await aiClient.generateWithTools({
      systemPrompt, messages: [{ role: 'user', content: q.question }],
      tools: tools.declarations, executor: exec, maxIterations: 5,
    });
  } catch (err) {
    return { questionId: q.id, intent: cls.intent, reply: '[error]', score: 0, reasoning: 'agent error: ' + err.message };
  }
  const j = await judge(q.question, q.expected_intent, llm.text, cls.intent);
  return { questionId: q.id, intent: cls.intent, reply: llm.text, score: j.score, reasoning: j.reasoning };
}

async function run() {
  const { rows: questions } = await pg.query(
    `SELECT id, category, question, expected_intent FROM crm_synthetic_questions WHERE active = TRUE`
  );
  if (!questions.length) { logger.info('[synth] no questions'); await pg.end(); return; }
  logger.info({ count: questions.length }, '[synth] starting');
  let pass = 0, total = 0;
  for (const q of questions) {
    total++;
    try {
      const r = await runOne(q);
      await pg.query(
        `INSERT INTO crm_synthetic_eval_runs (question_id, ai_reply, intent, score, reasoning)
         VALUES ($1, $2, $3, $4, $5)`,
        [r.questionId, (r.reply || '').slice(0, 2000), r.intent || null, Number(r.score) || 0, r.reasoning || null]
      );
      if (Number(r.score) >= 4) pass++;
    } catch (err) { logger.warn({ err: err.message, qid: q.id }, '[synth] one failed'); }
  }
  const passRate = total ? ((pass / total) * 100).toFixed(1) : 0;
  logger.info({ total, pass, pass_rate: passRate }, '[synth] done');
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[synth] failed'); process.exit(1); });
}
module.exports = { run };
