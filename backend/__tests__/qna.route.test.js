jest.mock('../db/postgres');
jest.mock('../middleware/auth', () => ({ requireStaff: (req, _res, next) => next() }));
jest.mock('../services/qnaRag', () => ({ upsertQna: jest.fn(async () => 7), embedPending: jest.fn(async () => 1) }));
const pg = require('../db/postgres');
const qnaRag = require('../services/qnaRag');
const express = require('express');
const request = require('supertest');
function appWith(staff) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.staff = staff; next(); });
  app.use('/api/qna', require('../routes/qna'));
  return app;
}
const ADMIN = { staff_id: 1, role: 'admin' };
afterEach(() => jest.clearAllMocks());

test('403 non-admin', async () => {
  const r = await request(appWith({ staff_id: 2, role: 'operator' })).get('/api/qna');
  expect(r.status).toBe(403);
});
test('list', async () => {
  pg.query.mockResolvedValueOnce({ rows: [{ id: 1, question: 'q', answer: 'a' }] });
  const r = await request(appWith(ADMIN)).get('/api/qna');
  expect(r.status).toBe(200);
  expect(r.body.items).toHaveLength(1);
});
test('create → upsertQna + embedPending', async () => {
  const r = await request(appWith(ADMIN)).post('/api/qna').send({ question: 'harga?', answer: 'mulai 300rb' });
  expect(r.status).toBe(200);
  expect(qnaRag.upsertQna).toHaveBeenCalled();
  expect(r.body.id).toBe(7);
});
test('create tanpa question/answer → 400', async () => {
  const r = await request(appWith(ADMIN)).post('/api/qna').send({ question: 'x' });
  expect(r.status).toBe(400);
});
