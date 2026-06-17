// backend/__tests__/supervisorControlPanel.test.js
jest.mock('../db/postgres');
jest.mock('../db/lotus');
jest.mock('../middleware/auth', () => ({ requireStaff: (req, _res, next) => next() }));
const pg = require('../db/postgres');
const lotus = require('../db/lotus');
const express = require('express');
const request = require('supertest');

function appWith(staff) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.staff = staff; next(); });
  app.use('/api/supervisor-control', require('../routes/supervisorControl'));
  return app;
}
const ADMIN = { staff_id: 1, role: 'admin' };
const minAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
afterEach(() => jest.clearAllMocks());

describe('GET /panel', () => {
  test('403 non-admin', async () => {
    const res = await request(appWith({ staff_id: 2, role: 'operator' })).get('/api/supervisor-control/panel');
    expect(res.status).toBe(403);
  });

  test('rakit priority_queue + groups', async () => {
    lotus.query.mockResolvedValue({ rows: [
      { lotus_id: 'A', cust_number: '1', cust_name: 'Ani', business_number: '628',
        last_message: 'harganya brp kak?', last_message_from: 'inbound', last_message_at: minAgo(20),
        last_inbound_at: minAgo(20), last_outbound_at: null, first_inbound_at: minAgo(20),
        inbound_count: 1, fu_count_today: 0, assign_to_user_name: 'Rina' },
    ] });
    pg.query.mockResolvedValue({ rows: [
      { lotus_id: 'A', status: 'active', assigned_staff_id: 7, root_cause_tag: null, funnel_stage_lost: null,
        lead_temperature: 'warm', lead_score: 10, last_intent: 'tanya_harga' },
    ] });
    const res = await request(appWith(ADMIN)).get('/api/supervisor-control/panel');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.priority_queue)).toBe(true);
    const a = res.body.priority_queue.find((x) => x.lotus_id === 'A');
    expect(a).toBeTruthy();
    expect(a.priority).toBe('P1');
    expect(res.body.groups.sales_response_risk.map((x) => x.lotus_id)).toContain('A');
  });
});
