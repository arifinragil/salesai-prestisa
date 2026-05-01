const pg = require('../db/postgres');
const { getTodayCostUsd, getCap, checkCap } = require('../services/costGuard');
const { setSetting, invalidateCache } = require('../services/settings');

const TEST_PHONE = `62444${Date.now() % 10000000}`;
let convId;

beforeAll(async () => {
  const c = await pg.query(
    `INSERT INTO crm_conversations (phone, last_message_at) VALUES ($1, now()) RETURNING id`,
    [TEST_PHONE]
  );
  convId = c.rows[0].id;
});

afterAll(async () => {
  await pg.query(`DELETE FROM crm_messages WHERE conversation_id = $1`, [convId]);
  await pg.query(`DELETE FROM crm_conversations WHERE id = $1`, [convId]);
  await pg.end();
});

test('getTodayCostUsd sums today ai messages', async () => {
  // 1M input + 1M output = $3 + $15 = $18
  await pg.query(
    `INSERT INTO crm_messages (conversation_id, direction, sender_type, body, ai_metadata, created_at)
     VALUES ($1, 'out', 'ai', 'a', '{"tokens_in":1000000,"tokens_out":1000000}'::jsonb, now())`,
    [convId]
  );
  const cost = await getTodayCostUsd();
  expect(cost).toBeGreaterThanOrEqual(18);
});

test('getCap reads from settings', async () => {
  invalidateCache();
  await setSetting('daily_cost_cap_usd', 12.5);
  const cap = await getCap();
  expect(cap).toBe(12.5);
});

test('getCap falls back to env then default', async () => {
  invalidateCache();
  await pg.query(`DELETE FROM crm_settings WHERE key = 'daily_cost_cap_usd'`);
  const orig = process.env.AI_DAILY_COST_CAP_USD;
  process.env.AI_DAILY_COST_CAP_USD = '99';
  invalidateCache();
  expect(await getCap()).toBe(99);
  delete process.env.AI_DAILY_COST_CAP_USD;
  invalidateCache();
  expect(await getCap()).toBe(5);
  process.env.AI_DAILY_COST_CAP_USD = orig || '';
  // restore default for other tests
  await setSetting('daily_cost_cap_usd', 5);
});

test('checkCap returns overCap when current >= cap', async () => {
  invalidateCache();
  await setSetting('daily_cost_cap_usd', 1);
  const r = await checkCap();
  expect(r.overCap).toBe(true);
  expect(r.cap).toBe(1);
  expect(r.current).toBeGreaterThanOrEqual(1);
  await setSetting('daily_cost_cap_usd', 5); // restore
});
