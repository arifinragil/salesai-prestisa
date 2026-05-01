const express = require('express');
const request = require('supertest');
const healthRoutes = require('../routes/health');

const app = express();
app.use(healthRoutes);

afterAll(async () => {
  const pg = require('../db/postgres');
  const mysql = require('../db/mysql');
  await pg.end();
  await mysql.end();
});

test('GET /healthz returns ok', async () => {
  const r = await request(app).get('/healthz');
  expect(r.status).toBe(200);
  expect(r.body.ok).toBe(true);
});

test('GET /readyz checks PG and Mysql (best-effort)', async () => {
  const r = await request(app).get('/readyz');
  expect([200, 503]).toContain(r.status);
  expect(r.body).toHaveProperty('postgres');
  expect(r.body).toHaveProperty('mysql');
});
