const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const pg = require('../db/postgres');
const authRoutes = require('../routes/auth');
const { hashPassword } = require('../services/password');

const TEST_USER = `pilot_test_${Date.now()}`;
const TEST_PASS = 'TestPass123!';

let app;

beforeAll(async () => {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS staff_users (
      id SERIAL PRIMARY KEY, username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL, full_name VARCHAR(100),
      role VARCHAR(20) DEFAULT 'staff', active BOOLEAN DEFAULT true,
      last_login_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await pg.query(
    `INSERT INTO staff_users (username, password_hash, full_name, role) VALUES ($1, $2, 'Pilot Test', 'admin')`,
    [TEST_USER, hashPassword(TEST_PASS)]
  );
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
});

afterAll(async () => {
  await pg.query(`DELETE FROM staff_users WHERE username = $1`, [TEST_USER]);
  await pg.end();
});

test('POST /login rejects empty body', async () => {
  const r = await request(app).post('/api/auth/login').send({});
  expect(r.status).toBe(400);
  expect(r.body.success).toBe(false);
});

test('POST /login rejects bad password', async () => {
  const r = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER, password: 'wrong' });
  expect(r.status).toBe(401);
});

test('POST /login succeeds and sets cookie', async () => {
  const r = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER, password: TEST_PASS });
  expect(r.status).toBe(200);
  expect(r.body.success).toBe(true);
  expect(r.body.user.username).toBe(TEST_USER);
  expect(r.headers['set-cookie'][0]).toMatch(/crm_pilot_token=/);
});

test('GET /me requires auth', async () => {
  const r = await request(app).get('/api/auth/me');
  expect(r.status).toBe(401);
});

test('GET /me returns user when authed', async () => {
  const login = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER, password: TEST_PASS });
  const cookie = login.headers['set-cookie'];
  const r = await request(app).get('/api/auth/me').set('Cookie', cookie);
  expect(r.status).toBe(200);
  expect(r.body.user.username).toBe(TEST_USER);
});
