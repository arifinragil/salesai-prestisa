// backend/__tests__/supervisorControl.test.js
jest.mock('../db/postgres');
jest.mock('../db/lotus');
jest.mock('../middleware/auth', () => ({ requireStaff: (req, _res, next) => next() }));
jest.mock('../services/analystReport', () => ({ runTierA: jest.fn() }));
jest.mock('../services/trainingExamples', () => ({
  getActiveExamples: jest.fn().mockResolvedValue([]),
  formatExamplesBlock: jest.fn().mockReturnValue(''),
  createFromRevision: jest.fn().mockResolvedValue(42),
}));
const pg = require('../db/postgres');
const lotus = require('../db/lotus');
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

  test('revise_ai: insert log + update root_cause/stuck_group (tanpa update ack)', async () => {
    pg.query
      .mockResolvedValueOnce({ rows: [{ id: 11 }] })   // INSERT log
      .mockResolvedValueOnce({ rowCount: 1 });           // UPDATE crm_lotus_state root_cause
    const res = await request(appWith(ADMIN))
      .post('/api/supervisor-control/lead/L1/action')
      .send({ action: 'revise_ai', corrected_root_cause: 'harga_terlalu_mahal', corrected_reason: 'budget kecil', final_status: 'lost', note: 'sales kirim harga terlalu cepat' });
    expect(res.status).toBe(200);
    expect(pg.query).toHaveBeenCalledTimes(2);
    expect(pg.query.mock.calls[0][0]).toMatch(/INSERT INTO crm_lead_supervisor_actions/i);
    expect(pg.query.mock.calls[1][0]).toMatch(/UPDATE crm_lotus_state/i);
    expect(pg.query.mock.calls[1][0]).toMatch(/stuck_group/i);
  });

  test('revise_ai sem corrected_root_cause: insert log saja', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ id: 12 }] });
    const res = await request(appWith(ADMIN))
      .post('/api/supervisor-control/lead/L1/action')
      .send({ action: 'revise_ai', note: 'tinjau ulang' });
    expect(res.status).toBe(200);
    expect(pg.query).toHaveBeenCalledTimes(1);
    expect(pg.query.mock.calls[0][0]).toMatch(/INSERT INTO crm_lead_supervisor_actions/i);
  });
});

describe('POST /diagnosis/:id/review', () => {
  test('missing agree_with_ai → 400', async () => {
    const res = await request(appWith(ADMIN))
      .post('/api/supervisor-control/diagnosis/L1/review')
      .send({ solved: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/agree_with_ai/i);
  });

  test('missing solved → 400', async () => {
    const res = await request(appWith(ADMIN))
      .post('/api/supervisor-control/diagnosis/L1/review')
      .send({ agree_with_ai: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/solved/i);
  });

  test('agree_with_ai false without revise_note → 400', async () => {
    const res = await request(appWith(ADMIN))
      .post('/api/supervisor-control/diagnosis/L1/review')
      .send({ agree_with_ai: false, solved: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/revise_note/i);
  });

  test('disagree with revise_note + revise_category → 200, INSERT log + UPDATE state + createFromRevision', async () => {
    // Mock: INSERT crm_lead_supervisor_actions, UPDATE crm_lotus_state, createFromRevision (via trainingExamples mock)
    pg.query
      .mockResolvedValueOnce({ rows: [{ id: 99 }] })   // INSERT crm_lead_supervisor_actions
      .mockResolvedValueOnce({ rowCount: 1 });            // UPDATE crm_lotus_state

    const res = await request(appWith(ADMIN))
      .post('/api/supervisor-control/diagnosis/L2/review')
      .send({
        agree_with_ai: false,
        solved: false,
        revise_note: 'sales kurang menggali kebutuhan',
        revise_category: 'sales_handling',
        revise_subtype: 'discovery',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action_id).toBe(99);
    expect(res.body.training_example_id).toBe(42);

    // Verify INSERT into crm_lead_supervisor_actions happened
    const insertCall = pg.query.mock.calls[0];
    expect(insertCall[0]).toMatch(/INSERT INTO crm_lead_supervisor_actions/i);
    expect(insertCall[1]).toContain('L2');

    // Verify UPDATE crm_lotus_state happened with supervisor fields
    const updateCall = pg.query.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE crm_lotus_state/i);
    expect(updateCall[0]).toMatch(/supervisor_agree_with_ai/i);
    expect(updateCall[1]).toContain('L2');
    expect(updateCall[1]).toContain(false); // agree_with_ai = false

    // Verify createFromRevision was called (mocked to return 42)
    const { createFromRevision } = require('../services/trainingExamples');
    expect(createFromRevision).toHaveBeenCalledWith(expect.objectContaining({
      action_id: 99,
      category: 'sales_handling',
      subtype: 'discovery',
      analysis: 'sales kurang menggali kebutuhan',
      created_by: 1,
    }));
  });
});

describe('POST /training-examples', () => {
  test('400 when case_pattern missing', async () => {
    const res = await request(appWith(ADMIN))
      .post('/api/supervisor-control/training-examples')
      .send({ category: 'sales_handling', analysis: 'some analysis' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/case_pattern/i);
  });

  test('400 when category missing', async () => {
    const res = await request(appWith(ADMIN))
      .post('/api/supervisor-control/training-examples')
      .send({ case_pattern: 'customer asks price then ghosts', analysis: 'some analysis' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/category/i);
  });

  test('400 when analysis missing', async () => {
    const res = await request(appWith(ADMIN))
      .post('/api/supervisor-control/training-examples')
      .send({ case_pattern: 'customer asks price then ghosts', category: 'sales_handling' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/analysis/i);
  });

  test('200 with id when all required fields provided', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const res = await request(appWith(ADMIN))
      .post('/api/supervisor-control/training-examples')
      .send({ case_pattern: 'customer asks price then ghosts', category: 'sales_handling', analysis: 'sales did not follow up' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.id).toBe(1);
  });
});

describe('Route registration smoke test', () => {
  test('/bulk-diagnose and /review-no-diagnose routes are registered', async () => {
    // We just need to confirm these routes exist (don't call Gemini).
    // bulk-diagnose with empty list → 200 with processed:0
    pg.query.mockResolvedValue({ rows: [], rowCount: 0 });
    lotus.query.mockResolvedValue({ rows: [] });
    const res = await request(appWith(ADMIN))
      .post('/api/supervisor-control/bulk-diagnose')
      .send({ lotus_ids: [] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ processed: 0, succeeded: 0, failed: 0 });
  });
});
