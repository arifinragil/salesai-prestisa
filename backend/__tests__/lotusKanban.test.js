// backend/__tests__/lotusKanban.test.js
jest.mock('../db/lotus');
jest.mock('../db/postgres');
jest.mock('../db/mysql', () => ({ query: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  requireStaff: (req, _res, next) => next(),
}));
const lotus = require('../db/lotus');
const pg = require('../db/postgres');
const express = require('express');
const request = require('supertest');

function appWith(staff) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.staff = staff; next(); });
  app.use('/api/lotus-inbox', require('../routes/lotusInbox'));
  return app;
}
const ADMIN = { staff_id: 1, role: 'admin', username: 'boss' };
const SALES = { staff_id: 7, role: 'operator', username: 'rina' };

afterEach(() => jest.clearAllMocks());

function stubData(contactRows, stateRows) {
  lotus.query.mockResolvedValue({ rows: contactRows });
  pg.query.mockResolvedValue({ rows: stateRows });
}
const minAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

describe('GET /contacts ?tab=urgent', () => {
  test('hanya lead yang cocok tab urgent yang lolos', async () => {
    stubData(
      [
        { lotus_id: 'A', cust_number: '1', cust_name: 'Ani', last_message_from: 'inbound', last_message_at: minAgo(40), last_inbound_at: minAgo(40) },
        { lotus_id: 'B', cust_number: '2', cust_name: 'Budi', last_message_from: 'inbound', last_message_at: minAgo(5),  last_inbound_at: minAgo(5) },
      ],
      [
        { lotus_id: 'A', status: 'active', assigned_staff_id: 7 },
        { lotus_id: 'B', status: 'active', assigned_staff_id: 7 },
      ]
    );
    const res = await request(appWith(ADMIN)).get('/api/lotus-inbox/contacts?tab=urgent');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.lotus_id)).toEqual(['A']);
  });

  test('item shape mengekspos field state baru', async () => {
    stubData(
      [{ lotus_id: 'A', cust_number: '1', cust_name: 'Ani', last_message_from: 'inbound', last_message_at: minAgo(40) }],
      [{ lotus_id: 'A', status: 'active', assigned_staff_id: 7, lead_score: 55, last_intent: 'tanya_harga', root_cause_tag: 'window_shopping', first_inbound_at: minAgo(120), handover_count: 1 }]
    );
    const res = await request(appWith(ADMIN)).get('/api/lotus-inbox/contacts?tab=all');
    const it = res.body.items[0];
    expect(it).toHaveProperty('lead_score', 55);
    expect(it).toHaveProperty('last_intent', 'tanya_harga');
    expect(it).toHaveProperty('root_cause_tag', 'window_shopping');
    expect(it).toHaveProperty('first_inbound_at');
    expect(it).toHaveProperty('handover_count', 1);
  });
});

describe('scoping by role', () => {
  test('sales (non-admin) hanya lihat lead assigned ke dirinya', async () => {
    stubData(
      [
        { lotus_id: 'A', cust_number: '1', cust_name: 'Ani', last_message_from: 'inbound', last_message_at: minAgo(40) },
        { lotus_id: 'C', cust_number: '3', cust_name: 'Cici', last_message_from: 'inbound', last_message_at: minAgo(40) },
      ],
      [
        { lotus_id: 'A', status: 'active', assigned_staff_id: 7 },
        { lotus_id: 'C', status: 'active', assigned_staff_id: 99 },
      ]
    );
    const res = await request(appWith(SALES)).get('/api/lotus-inbox/contacts?tab=all');
    expect(res.body.items.map((i) => i.lotus_id)).toEqual(['A']);
  });

  test('admin lihat semua', async () => {
    stubData(
      [
        { lotus_id: 'A', cust_number: '1', cust_name: 'Ani', last_message_from: 'inbound', last_message_at: minAgo(40) },
        { lotus_id: 'C', cust_number: '3', cust_name: 'Cici', last_message_from: 'inbound', last_message_at: minAgo(40) },
      ],
      [
        { lotus_id: 'A', status: 'active', assigned_staff_id: 7 },
        { lotus_id: 'C', status: 'active', assigned_staff_id: 99 },
      ]
    );
    const res = await request(appWith(ADMIN)).get('/api/lotus-inbox/contacts?tab=all');
    expect(res.body.items.map((i) => i.lotus_id).sort()).toEqual(['A', 'C']);
  });
});

describe('GET /tab-counts', () => {
  test('mengembalikan hitungan per tab dalam scope', async () => {
    stubData(
      [
        { lotus_id: 'A', cust_number: '1', last_message_from: 'inbound', last_message_at: minAgo(40) },
        { lotus_id: 'B', cust_number: '2', last_message_from: 'outbound', last_message_at: minAgo(180) },
      ],
      [
        { lotus_id: 'A', status: 'active', assigned_staff_id: 7, lead_temperature: 'hot' },
        { lotus_id: 'B', status: 'active', assigned_staff_id: 7 },
      ]
    );
    const res = await request(appWith(ADMIN)).get('/api/lotus-inbox/tab-counts');
    expect(res.status).toBe(200);
    expect(res.body.counts.all).toBe(2);
    expect(res.body.counts.urgent).toBe(1);
    expect(res.body.counts.tunggu_balas).toBe(1);
    expect(res.body.counts.tunggu_cust).toBe(1);
    expect(res.body.counts.hot_asap).toBe(1);
  });

  test('non-admin hanya menghitung lead miliknya', async () => {
    stubData(
      [
        { lotus_id: 'A', cust_number: '1', last_message_from: 'inbound', last_message_at: minAgo(40) },
        { lotus_id: 'C', cust_number: '3', last_message_from: 'inbound', last_message_at: minAgo(40) },
      ],
      [
        { lotus_id: 'A', status: 'active', assigned_staff_id: 7 },
        { lotus_id: 'C', status: 'active', assigned_staff_id: 99 },
      ]
    );
    const res = await request(appWith(SALES)).get('/api/lotus-inbox/tab-counts');
    expect(res.body.counts.all).toBe(1);
  });
});

describe('first_inbound_at derived from messages (state empty)', () => {
  const dAgo = (d) => new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();
  test('anchor diambil dari kolom contact (derived) saat state.first_inbound_at kosong', async () => {
    stubData(
      [{ lotus_id: 'A', cust_number: '1', last_message_from: 'outbound', last_message_at: dAgo(2), first_inbound_at: dAgo(2) }],
      [{ lotus_id: 'A', status: 'active', assigned_staff_id: 7 }] // state TANPA first_inbound_at
    );
    const res = await request(appWith(ADMIN)).get('/api/lotus-inbox/contacts?tab=fu_overdue');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.lotus_id)).toEqual(['A']);
  });
});

describe('FU overdue (filter + counts)', () => {
  const dAgo = (d) => new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();

  test('?tab=fu_overdue hanya lead yang FU-nya overdue', async () => {
    stubData(
      [
        { lotus_id: 'A', cust_number: '1', last_message_from: 'outbound', last_message_at: dAgo(2) },
        { lotus_id: 'B', cust_number: '2', last_message_from: 'inbound',  last_message_at: dAgo(0.1) },
      ],
      [
        { lotus_id: 'A', status: 'active', assigned_staff_id: 7, first_inbound_at: dAgo(2) },
        { lotus_id: 'B', status: 'active', assigned_staff_id: 7, first_inbound_at: dAgo(0.2) },
      ]
    );
    const res = await request(appWith(ADMIN)).get('/api/lotus-inbox/contacts?tab=fu_overdue');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.lotus_id)).toEqual(['A']);
  });

  test('/tab-counts memuat fu_overdue & fu_pending', async () => {
    stubData(
      [
        { lotus_id: 'A', cust_number: '1', last_message_from: 'outbound', last_message_at: dAgo(2) },
        { lotus_id: 'B', cust_number: '2', last_message_from: 'inbound',  last_message_at: dAgo(0.1) },
      ],
      [
        { lotus_id: 'A', status: 'active', assigned_staff_id: 7, first_inbound_at: dAgo(2) },
        { lotus_id: 'B', status: 'active', assigned_staff_id: 7, first_inbound_at: dAgo(0.2) },
      ]
    );
    const res = await request(appWith(ADMIN)).get('/api/lotus-inbox/tab-counts');
    expect(res.body.counts).toHaveProperty('fu_overdue', 1);
    expect(res.body.counts).toHaveProperty('fu_pending');
    expect(res.body.counts.fu_pending).toBeGreaterThanOrEqual(1);
  });
});

describe('FU stale (expired bucket)', () => {
  const dAgo = (d) => new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();
  test('?tab=fu_stale hanya lead expired (>H+7 tanpa FU)', async () => {
    stubData(
      [
        { lotus_id: 'A', cust_number: '1', last_message_from: 'inbound', last_message_at: dAgo(10), first_inbound_at: dAgo(10) },
        { lotus_id: 'B', cust_number: '2', last_message_from: 'inbound', last_message_at: dAgo(2),  first_inbound_at: dAgo(2) },
      ],
      [
        { lotus_id: 'A', status: 'active', assigned_staff_id: 7 }, // H+10 no outbound → expired
        { lotus_id: 'B', status: 'active', assigned_staff_id: 7 }, // H+2 no outbound → overdue
      ]
    );
    const res = await request(appWith(ADMIN)).get('/api/lotus-inbox/contacts?tab=fu_stale');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.lotus_id)).toEqual(['A']);
  });

  test('/tab-counts memuat fu_stale', async () => {
    stubData(
      [{ lotus_id: 'A', cust_number: '1', last_message_from: 'inbound', last_message_at: dAgo(10), first_inbound_at: dAgo(10) }],
      [{ lotus_id: 'A', status: 'active', assigned_staff_id: 7 }]
    );
    const res = await request(appWith(ADMIN)).get('/api/lotus-inbox/tab-counts');
    expect(res.body.counts).toHaveProperty('fu_stale', 1);
  });
});
