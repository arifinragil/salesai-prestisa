const pg = require('../db/postgres');
const { getSetting, setSetting, invalidateCache } = require('../services/settings');

afterAll(async () => {
  await pg.query(`DELETE FROM crm_settings WHERE key LIKE 'test_%'`);
  await pg.end();
});

beforeEach(() => invalidateCache());

test('getSetting returns fallback for missing key', async () => {
  const v = await getSetting('test_nonexistent', 42);
  expect(v).toBe(42);
});

test('setSetting + getSetting roundtrip (number)', async () => {
  await setSetting('test_number', 7.5);
  const v = await getSetting('test_number', 0);
  expect(v).toBe(7.5);
});

test('setSetting + getSetting roundtrip (boolean)', async () => {
  await setSetting('test_bool', true);
  const v = await getSetting('test_bool', false);
  expect(v).toBe(true);
});

test('setSetting + getSetting roundtrip (object)', async () => {
  await setSetting('test_obj', { a: 1, b: 'x' });
  const v = await getSetting('test_obj', null);
  expect(v).toEqual({ a: 1, b: 'x' });
});

test('cache invalidates on setSetting', async () => {
  await setSetting('test_cache', 1);
  expect(await getSetting('test_cache', 0)).toBe(1);
  await setSetting('test_cache', 2);
  expect(await getSetting('test_cache', 0)).toBe(2);
});
