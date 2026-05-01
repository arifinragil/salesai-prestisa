require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const gemini = require('../services/geminiClient');
const claude = require('../services/claudeClient');
const tools = require('../services/aiTools');
const persona = require('../services/aiPersona');
const guardrails = require('../services/aiGuardrails');
const confidence = require('../services/aiConfidence');
const logger = require('../services/logger');
const pg = require('../db/postgres');
const mysql = require('../db/mysql');

async function runOne(testCase, systemPrompt) {
  const cls = await gemini.classifyIntent(testCase.input);
  const dangerous = gemini.isDangerous(cls.intent);

  const result = {
    id: testCase.id, input: testCase.input,
    expected: testCase.expect, actual: { intent: cls.intent, handover: dangerous, tools_called: [] },
    passed: false, reasons: [],
  };

  if (testCase.expect.intent && testCase.expect.intent !== cls.intent) {
    result.reasons.push(`intent mismatch: expected ${testCase.expect.intent}, got ${cls.intent}`);
  }
  if (typeof testCase.expect.handover === 'boolean' && testCase.expect.handover !== dangerous) {
    result.reasons.push(`handover mismatch: expected ${testCase.expect.handover}, got ${dangerous}`);
  }

  if (!dangerous && testCase.expect.tool_called) {
    const fakeConv = { id: 0, phone: '628000000000', customer_id: null, last_intent: cls.intent };
    const exec = (name, args) => {
      const fn = tools.executors[name];
      if (!fn) return Promise.resolve({ error: `unknown tool ${name}` });
      return Promise.resolve(fn({ args, conv: fakeConv, customer_id: null, phone: fakeConv.phone }));
    };
    let llm;
    try {
      llm = await claude.generateWithTools({
        systemPrompt,
        messages: [{ role: 'user', content: testCase.input }],
        tools: tools.declarations, executor: exec, maxIterations: 3,
      });
    } catch (err) {
      result.reasons.push(`claude error: ${err.message}`);
      return result;
    }
    result.actual.tools_called = llm.calls.map((c) => c.name);
    result.actual.text = llm.text;
    if (!result.actual.tools_called.includes(testCase.expect.tool_called)) {
      result.reasons.push(`tool_called mismatch: expected ${testCase.expect.tool_called}, got [${result.actual.tools_called.join(',')}]`);
    }

    const check = guardrails.checkReply({ reply: llm.text, toolCalls: llm.calls });
    if (!check.passed) result.reasons.push(`post-check failed: ${check.reason}`);

    const score = confidence.scoreReply({ reply: llm.text, toolCalls: llm.calls, intent: cls.intent, iterationsCapped: false });
    result.actual.confidence = score;
  }

  result.passed = result.reasons.length === 0;
  return result;
}

async function run() {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'evalCases.json'), 'utf8'));
  const systemPrompt = await persona.buildSystemPrompt({
    conv: { id: 0, phone: '628000000000', customer_id: null, last_intent: null },
    customerName: null, cityHint: null,
  });

  logger.info({ total: cases.length }, '[eval] running');
  const results = [];
  for (const c of cases) {
    try {
      const r = await runOne(c, systemPrompt);
      results.push(r);
      logger.info({ id: r.id, passed: r.passed, reasons: r.reasons }, '[eval] case');
    } catch (err) {
      results.push({ id: c.id, passed: false, reasons: [`unhandled: ${err.message}`] });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const rate = (passed / results.length) * 100;
  const summary = { total: results.length, passed, rate: rate.toFixed(1) + '%' };
  logger.info(summary, '[eval] summary');

  fs.writeFileSync(
    path.join(__dirname, '..', 'eval-results.json'),
    JSON.stringify({ summary, results, ranAt: new Date().toISOString() }, null, 2)
  );

  await pg.end(); await mysql.end();
  if (rate < 85) {
    console.error(`FAIL: ${rate.toFixed(1)}% < 85% required`);
    process.exit(2);
  }
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[eval] failed'); process.exit(1); });
}

module.exports = { runOne, run };
