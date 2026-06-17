// backend/__tests__/supervisorControl.test.js
jest.mock('../db/postgres');
const pg = require('../db/postgres');
const express = require('express');
const request = require('supertest');

function appWith(staff) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.staff = staff; next(); });
  app.use('/api/supervisor-control', require('../routes/supervisorControl'));
  return app;
}
const ADMIN = { staff_id: 1, role: 'admin', username: 'boss' };

afterEach(() => jest.clearAllMocks());

describe('POST /lead/:id/action', () => {
  test('403 untuk non-admin', async () => {
    const res = await request(appWith({ staff_id: 2, role: 'operator' }))
      .post('/api/supervisor-control/lead/L1/action').send({ action: 'ack' });
    expect(res.status).toBe(403);
  });

  test('action tak dikenal → 400', async () => {
    const res = await request(appWith(ADMIN))
      .post('/api/supervisor-control/lead/L1/action').send({ action: 'nope' });
    expect(res.status).toBe(400);
  });

  test('ack: insert log + update ack flag', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ id: 10 }] }).mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(appWith(ADMIN))
      .post('/api/supervisor-control/lead/L1/action').send({ action: 'ack', note: 'sesuai' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(pg.query).toHaveBeenCalledTimes(2);
    expect(pg.query.mock.calls[1][0]).toMatch(/UPDATE crm_lotus_state/i);
  });

  test('revise_ai: insert log saja (tanpa update ack)', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ id: 11 }] });
    const res = await request(appWith(ADMIN))
      .post('/api/supervisor-control/lead/L1/action')
      .send({ action: 'revise_ai', corrected_root_cause: 'harga_terlalu_mahal', corrected_reason: 'budget kecil', final_status: 'lost', note: 'sales kirim harga terlalu cepat' });
    expect(res.status).toBe(200);
    expect(pg.query).toHaveBeenCalledTimes(1);
    expect(pg.query.mock.calls[0][0]).toMatch(/INSERT INTO crm_lead_supervisor_actions/i);
  });
});
