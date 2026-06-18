'use strict';
jest.mock('../db/postgres');
jest.mock('../middleware/auth', () => ({ requireStaff: (_req, _res, next) => next() }));
jest.mock('../services/penyebabAnalyze', () => ({ analyzeLead: jest.fn(async () => ({ lotus_id: 'L1' })) }));

const pg = require('../db/postgres');
const { analyzeLead } = require('../services/penyebabAnalyze');
const express = require('express');
const request = require('supertest');

function makeApp(staff) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.staff = staff; next(); });
  app.use('/api/penyebab', require('../routes/penyebab'));
  return app;
}

const ADMIN = { staff_id: 1, role: 'admin' };
const OPERATOR = { staff_id: 2, role: 'operator' };

afterEach(() => jest.clearAllMocks());

// ── GET /analysis ─────────────────────────────────────────────────────────────

test('GET /analysis returns aggregate for any staff', async () => {
  pg.query.mockResolvedValueOnce({ rows: [] });
  const r = await request(makeApp(OPERATOR)).get('/api/penyebab/analysis');
  expect(r.status).toBe(200);
  expect(r.body).toHaveProperty('totals');
  expect(r.body).toHaveProperty('issueTree');
  expect(r.body.count).toBe(0);
});

// ── POST /:lotus_id/analyze ───────────────────────────────────────────────────

test('POST /L1/analyze 403 for operator', async () => {
  const r = await request(makeApp(OPERATOR)).post('/api/penyebab/L1/analyze');
  expect(r.status).toBe(403);
});

test('POST /L1/analyze 200 for admin', async () => {
  const r = await request(makeApp(ADMIN)).post('/api/penyebab/L1/analyze');
  expect(r.status).toBe(200);
  expect(analyzeLead).toHaveBeenCalledWith('L1');
  expect(r.body.success).toBe(true);
});

// ── POST /bulk-analyze ────────────────────────────────────────────────────────

test('POST /bulk-analyze 403 for operator', async () => {
  const r = await request(makeApp(OPERATOR)).post('/api/penyebab/bulk-analyze').send({ lotus_ids: ['L1'] });
  expect(r.status).toBe(403);
});

test('POST /bulk-analyze 400 when lotus_ids missing', async () => {
  const r = await request(makeApp(ADMIN)).post('/api/penyebab/bulk-analyze').send({});
  expect(r.status).toBe(400);
});

test('POST /bulk-analyze 400 when lotus_ids empty array', async () => {
  const r = await request(makeApp(ADMIN)).post('/api/penyebab/bulk-analyze').send({ lotus_ids: [] });
  expect(r.status).toBe(400);
});

test('POST /bulk-analyze 400 when lotus_ids exceeds 100', async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `L${i}`);
  const r = await request(makeApp(ADMIN)).post('/api/penyebab/bulk-analyze').send({ lotus_ids: ids });
  expect(r.status).toBe(400);
});

test('POST /bulk-analyze processes ids sequentially and returns summary', async () => {
  analyzeLead
    .mockResolvedValueOnce({ lotus_id: 'L1' })
    .mockRejectedValueOnce(new Error('not found'));

  const r = await request(makeApp(ADMIN)).post('/api/penyebab/bulk-analyze').send({ lotus_ids: ['L1', 'L2'] });
  expect(r.status).toBe(200);
  expect(r.body.processed).toBe(2);
  expect(r.body.succeeded).toBe(1);
  expect(r.body.failed).toBe(1);
  expect(r.body.errors).toHaveLength(1);
  expect(r.body.errors[0].lotus_id).toBe('L2');
});
