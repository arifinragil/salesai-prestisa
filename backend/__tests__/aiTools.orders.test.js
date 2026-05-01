jest.mock('../db/mysql', () => ({ query: jest.fn(), end: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../db/postgres', () => ({ query: jest.fn(), end: jest.fn().mockResolvedValue(undefined) }));

const mysql = require('../db/mysql');
const pg = require('../db/postgres');
const { executors } = require('../services/aiTools');

const ctx = { conv: { id: 99 }, customer_id: 7, phone: '628111111111' };

beforeEach(() => { mysql.query.mockReset(); pg.query.mockReset(); });

describe('find_customer_orders', () => {
  test('returns recent orders scoped to customer_id', async () => {
    mysql.query.mockResolvedValueOnce([[
      { order_id: 100, order_number: 'ORD-100', total: 750000, status: 'approved', created_at: new Date() },
    ]]);
    const out = await executors.find_customer_orders({ args: { limit: 5 }, ...ctx });
    expect(out.count).toBe(1);
    expect(out.orders[0].order_id).toBe(100);
    const [, params] = mysql.query.mock.calls[0];
    expect(params).toContain(7);
  });

  test('handles no customer linked', async () => {
    const out = await executors.find_customer_orders({ args: {}, conv: { id: 1 }, customer_id: null, phone: '628' });
    expect(out.count).toBe(0);
    expect(out.note).toMatch(/belum terhubung/i);
    expect(mysql.query).not.toHaveBeenCalled();
  });

  test('clamps limit to max 20', async () => {
    mysql.query.mockResolvedValueOnce([[]]);
    await executors.find_customer_orders({ args: { limit: 999 }, ...ctx });
    const [sql] = mysql.query.mock.calls[0];
    expect(sql).toMatch(/LIMIT 20/);
  });
});

describe('get_order_status', () => {
  test('returns order with items and PO status', async () => {
    mysql.query
      .mockResolvedValueOnce([[{ id: 100, order_number: 'ORD-100', status: 'approved', total: 750000, created_at: new Date() }]])
      .mockResolvedValueOnce([[
        { id: 1, product_name: 'Papan A', qty: 1, price: 750000, status: 'producing', purchase_order_status: 'in_progress' },
      ]]);
    const out = await executors.get_order_status({ args: { order_id: 100 }, ...ctx });
    expect(out.order_number).toBe('ORD-100');
    expect(out.items).toHaveLength(1);
  });

  test('rejects access to order from another customer', async () => {
    mysql.query.mockResolvedValueOnce([[]]);
    const out = await executors.get_order_status({ args: { order_id: 100 }, ...ctx });
    expect(out.error).toMatch(/tidak ditemukan/i);
  });
});

describe('request_handover', () => {
  test('inserts crm_handovers row, pauses AI, returns ok', async () => {
    pg.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 555 }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    const out = await executors.request_handover({
      args: { reason: 'complaint', summary: 'customer complains about late delivery' }, ...ctx,
    });
    expect(out.ok).toBe(true);
    expect(out.handover_id).toBe(555);
    expect(pg.query).toHaveBeenCalledTimes(2);
  });

  test('rejects invalid reason', async () => {
    const out = await executors.request_handover({ args: { reason: 'lol', summary: 'x' }, ...ctx });
    expect(out.error).toMatch(/reason/);
  });
});
