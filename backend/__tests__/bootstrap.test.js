const request = require('supertest');

process.env.DISABLE_WORKER = 'true';

const { app } = require('../index');

afterAll(async () => {
  const pg = require('../db/postgres');
  const mysql = require('../db/mysql');
  await pg.end();
  await mysql.end();
});

test('Express app boots and /healthz responds', async () => {
  const r = await request(app).get('/healthz');
  expect(r.status).toBe(200);
});

test('app has io attached', () => {
  expect(app.get('io')).toBeDefined();
});
