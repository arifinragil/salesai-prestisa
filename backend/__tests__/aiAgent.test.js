process.env.WA_PROVIDER = 'waha';
process.env.AI_GLOBAL_ENABLED = 'true';
process.env.ANTHROPIC_API_KEY = 'test-dummy';
process.env.GEMINI_API_KEY = 'test-dummy';

jest.mock('../services/claudeClient', () => ({
  generateWithTools: jest.fn(),
}));
jest.mock('../services/geminiClient', () => ({
  classifyIntent: jest.fn(),
  isDangerous: (i) => ['complaint', 'refund', 'cancel', 'angry', 'legal', 'explicit_request_human'].includes(i),
}));
jest.mock('../services/waAdapters/wahaAdapter', () => ({
  name: 'waha',
  sendText: jest.fn().mockResolvedValue({ id: 'sent-msg-id' }),
  parseInbound: jest.fn(),
}));
jest.mock('../db/mysql', () => ({ query: jest.fn().mockResolvedValue([[]]), end: jest.fn().mockResolvedValue(undefined) }));

const pg = require('../db/postgres');
const claude = require('../services/claudeClient');
const gemini = require('../services/geminiClient');
const wahaAdapter = require('../services/waAdapters/wahaAdapter');
const { processOne, claimNextJob } = require('../services/aiAgent');

const TEST_PHONE = `62777${Date.now() % 10000000}`;

async function seedConvAndMessage(body) {
  const conv = await pg.query(
    `INSERT INTO crm_conversations (phone, last_message_at)
     VALUES ($1, now())
     ON CONFLICT (phone) DO UPDATE SET last_message_at = now()
     RETURNING id`,
    [TEST_PHONE]
  );
  const convId = conv.rows[0].id;
  const msg = await pg.query(
    `INSERT INTO crm_messages (conversation_id, direction, sender_type, body, message_type)
     VALUES ($1, 'in', 'customer', $2, 'text') RETURNING id`,
    [convId, body]
  );
  const job = await pg.query(
    `INSERT INTO crm_inbound_queue (message_id, conversation_id) VALUES ($1, $2) RETURNING id`,
    [msg.rows[0].id, convId]
  );
  return { convId, messageId: msg.rows[0].id, jobId: job.rows[0].id };
}

afterAll(async () => {
  await pg.query(`DELETE FROM crm_handovers
    WHERE conversation_id IN (SELECT id FROM crm_conversations WHERE phone = $1)`, [TEST_PHONE]);
  await pg.query(`DELETE FROM crm_inbound_queue
    WHERE conversation_id IN (SELECT id FROM crm_conversations WHERE phone = $1)`, [TEST_PHONE]);
  await pg.query(`DELETE FROM crm_messages
    WHERE conversation_id IN (SELECT id FROM crm_conversations WHERE phone = $1)`, [TEST_PHONE]);
  await pg.query(`DELETE FROM crm_conversations WHERE phone = $1`, [TEST_PHONE]);
  await pg.end();
});

beforeEach(() => {
  claude.generateWithTools.mockReset();
  gemini.classifyIntent.mockReset();
  wahaAdapter.sendText.mockClear();
});

test('happy path: clean reply gets sent via waClient', async () => {
  gemini.classifyIntent.mockResolvedValue({ intent: 'order_intent', confidence: 0.9 });
  claude.generateWithTools.mockResolvedValue({
    text: 'Halo Kak, mau pesan papan ya?',
    calls: [],
    usage: { input_tokens: 100, output_tokens: 20 },
    iterationsCapped: false,
  });

  const { jobId, convId } = await seedConvAndMessage('mau pesan papan');
  const result = await processOne();

  expect(result).toMatchObject({ ok: true, sent: true, conversation_id: convId });
  expect(wahaAdapter.sendText).toHaveBeenCalledWith(expect.objectContaining({ phone: TEST_PHONE, text: 'Halo Kak, mau pesan papan ya?' }));

  const out = await pg.query(
    `SELECT * FROM crm_messages WHERE conversation_id = $1 AND sender_type = 'ai'`,
    [convId]
  );
  expect(out.rows.length).toBeGreaterThanOrEqual(1);
  expect(out.rows[out.rows.length - 1].send_status).toBe('sent');

  const job = await pg.query(`SELECT status FROM crm_inbound_queue WHERE id = $1`, [jobId]);
  expect(job.rows[0].status).toBe('done');
});

test('dangerous intent → skip Claude, handover, send safe reply', async () => {
  gemini.classifyIntent.mockResolvedValue({ intent: 'complaint', confidence: 0.95 });

  const { convId } = await seedConvAndMessage('parah banget pesanan saya rusak');
  const result = await processOne();

  expect(result.ok).toBe(true);
  expect(result.handover).toBe(true);
  expect(claude.generateWithTools).not.toHaveBeenCalled();
  expect(wahaAdapter.sendText).toHaveBeenCalledWith(expect.objectContaining({
    text: expect.stringMatching(/sebentar|tim|panggilkan/i),
  }));

  const ho = await pg.query(`SELECT * FROM crm_handovers WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`, [convId]);
  expect(ho.rows[0].reason).toBe('complaint');

  const conv = await pg.query(`SELECT ai_paused_until FROM crm_conversations WHERE id = $1`, [convId]);
  expect(conv.rows[0].ai_paused_until).not.toBeNull();
});

test('shadow mode: AI runs but does NOT send', async () => {
  await pg.query(`UPDATE crm_conversations SET ai_paused_until = NULL WHERE phone = $1`, [TEST_PHONE]);
  gemini.classifyIntent.mockResolvedValue({ intent: 'pricing', confidence: 0.8 });
  claude.generateWithTools.mockResolvedValue({
    text: 'Halo Kak, ini info-nya ya?', calls: [], usage: { input_tokens: 50, output_tokens: 10 }, iterationsCapped: false,
  });

  const { convId } = await seedConvAndMessage('berapa harga papan?');
  await pg.query(`UPDATE crm_conversations SET shadow_mode = TRUE, ai_paused_until = NULL WHERE id = $1`, [convId]);

  const result = await processOne();
  expect(result.shadow).toBe(true);
  expect(wahaAdapter.sendText).not.toHaveBeenCalled();

  const out = await pg.query(`SELECT shadow FROM crm_messages WHERE conversation_id = $1 AND sender_type = 'ai' ORDER BY id DESC LIMIT 1`, [convId]);
  expect(out.rows[0].shadow).toBe(true);
});

test('ai_paused conversation → skip job (no Claude, no send)', async () => {
  await pg.query(`UPDATE crm_conversations SET shadow_mode = FALSE WHERE phone = $1`, [TEST_PHONE]);
  gemini.classifyIntent.mockResolvedValue({ intent: 'pricing', confidence: 0.8 });
  const { convId } = await seedConvAndMessage('hi');
  await pg.query(`UPDATE crm_conversations SET ai_paused_until = now() + INTERVAL '1 hour' WHERE id = $1`, [convId]);

  const result = await processOne();
  expect(result.skipped).toBe('paused');
  expect(claude.generateWithTools).not.toHaveBeenCalled();
});

test('post-check fails → handover instead of send', async () => {
  await pg.query(`UPDATE crm_conversations SET ai_paused_until = NULL, shadow_mode = FALSE WHERE phone = $1`, [TEST_PHONE]);
  gemini.classifyIntent.mockResolvedValue({ intent: 'pricing', confidence: 0.8 });
  claude.generateWithTools.mockResolvedValue({
    text: 'Harga 999.000',
    calls: [{ name: 'search_products', result: { products: [{ price: 500000 }] } }],
    usage: { input_tokens: 50, output_tokens: 10 }, iterationsCapped: false,
  });

  await seedConvAndMessage('berapa harga?');
  const result = await processOne();
  expect(result.handover).toBe(true);
  expect(result.handover_reason).toBe('post_check_failed');
});

test('iteration cap reached → handover', async () => {
  await pg.query(`UPDATE crm_conversations SET ai_paused_until = NULL, shadow_mode = FALSE WHERE phone = $1`, [TEST_PHONE]);
  gemini.classifyIntent.mockResolvedValue({ intent: 'order_intent', confidence: 0.7 });
  claude.generateWithTools.mockResolvedValue({
    text: 'oke', calls: [{ name: 'x' }], usage: { input_tokens: 50, output_tokens: 5 }, iterationsCapped: true,
  });

  await seedConvAndMessage('cari mawar');
  const result = await processOne();
  expect(result.handover).toBe(true);
  expect(result.handover_reason).toBe('iteration_cap');
});

test('global kill switch (AI_GLOBAL_ENABLED=false) → skip', async () => {
  await pg.query(`UPDATE crm_conversations SET ai_paused_until = NULL WHERE phone = $1`, [TEST_PHONE]);
  process.env.AI_GLOBAL_ENABLED = 'false';
  await seedConvAndMessage('hi');
  const result = await processOne();
  expect(result.skipped).toBe('ai_disabled_global');
  process.env.AI_GLOBAL_ENABLED = 'true';
});

test('claimNextJob respects FOR UPDATE SKIP LOCKED (no double-claim)', async () => {
  await pg.query(`UPDATE crm_conversations SET ai_paused_until = NULL WHERE phone = $1`, [TEST_PHONE]);
  await seedConvAndMessage('a');
  await seedConvAndMessage('b');

  const c1 = await pg.connect();
  const c2 = await pg.connect();
  try {
    await c1.query('BEGIN');
    await c2.query('BEGIN');
    const j1 = await claimNextJob(c1, 'worker-test-1');
    const j2 = await claimNextJob(c2, 'worker-test-2');
    expect(j1).not.toBeNull();
    expect(j2).not.toBeNull();
    expect(j1.id).not.toBe(j2.id);
    await c1.query('ROLLBACK');
    await c2.query('ROLLBACK');
  } finally {
    c1.release();
    c2.release();
  }
});
