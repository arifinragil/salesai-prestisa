jest.mock('../db/mysql', () => ({
  query: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../db/postgres', () => ({
  query: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
}));

const mysql = require('../db/mysql');
const pg = require('../db/postgres');
const { declarations, executors } = require('../services/aiTools');

const ctx = { conv: { id: 1 }, customer_id: 7, phone: '628111111111' };

beforeEach(() => { mysql.query.mockReset(); pg.query.mockReset(); });

test('declarations include core tools with anthropic input_schema', () => {
  const names = declarations.map((d) => d.name);
  expect(names).toEqual(expect.arrayContaining([
    'search_products', 'list_categories', 'get_shipping_info',
    'get_active_promos', 'get_faq', 'build_order_form_url',
  ]));
  for (const d of declarations) {
    expect(d).toHaveProperty('description');
    expect(d).toHaveProperty('input_schema');
    expect(d.input_schema.type).toBe('object');
  }
});

describe('search_products', () => {
  test('queries MySQL with filters and returns max 5', async () => {
    mysql.query.mockResolvedValueOnce([[
      { id: 1, name: 'Papan A', category: 'Sukacita', price: 500000, city: 'Jakarta', image_url: 'x', description: 'd' },
    ]]);
    const out = await executors.search_products({ args: { category: 'Sukacita', city: 'Jakarta', budget_max: 1000000 }, ...ctx });
    expect(out.count).toBe(1);
    expect(out.products[0].name).toBe('Papan A');
    const [sql, params] = mysql.query.mock.calls[0];
    expect(sql).toMatch(/LIMIT/);
    expect(params).toContain('Jakarta');
  });

  test('returns empty result with helpful note when no rows', async () => {
    mysql.query.mockResolvedValueOnce([[]]);
    const out = await executors.search_products({ args: { query: 'unicorn flowers' }, ...ctx });
    expect(out.count).toBe(0);
    expect(out.note).toMatch(/tidak ditemukan/i);
  });
});

describe('list_categories', () => {
  test('returns categories grouped by city', async () => {
    mysql.query.mockResolvedValueOnce([[
      { category_id: 1, name: 'Papan Sukacita', count: 12 },
      { category_id: 2, name: 'Bouquet', count: 8 },
    ]]);
    const out = await executors.list_categories({ args: { city: 'Jakarta' }, ...ctx });
    expect(out.categories).toHaveLength(2);
    expect(out.categories[0].name).toBe('Papan Sukacita');
  });
});

describe('get_shipping_info', () => {
  test('Jabodetabek = free', async () => {
    const out = await executors.get_shipping_info({ args: { destination_city: 'Jakarta Selatan' }, ...ctx });
    expect(out.fee).toBe(0);
    expect(out.eta_text).toMatch(/3-6 jam/);
  });
  test('Bandung = paid 50000', async () => {
    mysql.query.mockResolvedValueOnce([[{ '1': 1 }]]);
    const out = await executors.get_shipping_info({ args: { destination_city: 'Bandung' }, ...ctx });
    expect(out.fee).toBe(50000);
  });
  test('returns available=true for known cities', async () => {
    mysql.query.mockResolvedValueOnce([[{ '1': 1 }]]);
    const out = await executors.get_shipping_info({ args: { destination_city: 'Surabaya' }, ...ctx });
    expect(out.available).toBe(true);
  });
  test('returns available=false for unknown city', async () => {
    mysql.query.mockResolvedValueOnce([[]]);
    const out = await executors.get_shipping_info({ args: { destination_city: 'Atlantis' }, ...ctx });
    expect(out.available).toBe(false);
  });
});

describe('get_active_promos', () => {
  test('queries crm_promo_settings with active filter', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ code: 'WELCOME10', description: 'New cust 10%', discount_pct: 10, ends_at: new Date('2026-12-31') }] });
    const out = await executors.get_active_promos({ args: {}, ...ctx });
    expect(out.count).toBe(1);
    expect(out.promos[0].code).toBe('WELCOME10');
  });
  test('empty promo list returns helpful note', async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });
    const out = await executors.get_active_promos({ args: {}, ...ctx });
    expect(out.count).toBe(0);
    expect(out.note).toMatch(/belum ada/i);
  });
});

describe('get_faq', () => {
  test('returns text for valid topic', () => {
    const out = executors.get_faq({ args: { topic: 'payment' }, ...ctx });
    expect(out.text).toMatch(/transfer|va|qris/i);
  });
  test('returns error for invalid topic', () => {
    const out = executors.get_faq({ args: { topic: 'xyz' }, ...ctx });
    expect(out.error).toMatch(/topic/i);
  });
});

describe('build_order_form_url', () => {
  beforeAll(() => {
    process.env.ORDER_FORM_PAPAN_URL = 'https://orderpapan.prestisa.net';
    process.env.ORDER_FORM_BUNGA_URL = 'https://orderbunga.prestisa.net';
  });
  test('papan uses ORDER_FORM_PAPAN_URL with prefilled querystring', () => {
    const out = executors.build_order_form_url({
      args: { product_type: 'papan', prefill: { name: 'Andi', city: 'Jakarta' } }, ...ctx,
    });
    expect(out.url).toMatch(/^https:\/\/orderpapan\.prestisa\.net/);
    expect(out.url).toContain('phone=628111111111');
    expect(out.url).toContain('city=Jakarta');
  });
  test('bouquet uses ORDER_FORM_BUNGA_URL', () => {
    const out = executors.build_order_form_url({
      args: { product_type: 'bouquet', prefill: {} }, ...ctx,
    });
    expect(out.url).toMatch(/^https:\/\/orderbunga\.prestisa\.net/);
  });
  test('rejects unknown product_type', () => {
    const out = executors.build_order_form_url({
      args: { product_type: 'rocketship', prefill: {} }, ...ctx,
    });
    expect(out.error).toMatch(/product_type/i);
  });
});
