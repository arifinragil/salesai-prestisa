process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const pg = require('../db/postgres');
const adminRoutes = require('../routes/admin');
const { signToken } = require('../middleware/auth');
const { hashPassword } = require('../services/password');

const TEST_USER = `admin_test_${Date.now()}`;
let staffId, token, app;

beforeAll(async () => {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS staff_users (
      id SERIAL PRIMARY KEY, username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL, full_name VARCHAR(100),
      role VARCHAR(20) DEFAULT 'staff', active BOOLEAN DEFAULT true,
      last_login_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`);
  const u = await pg.query(
    `INSERT INTO staff_users (username, password_hash, role) VALUES ($1, $2, 'admin') RETURNING id`,
    [TEST_USER, hashPassword('x')]);
  staffId = u.rows[0].id;
  token = signToken({ staff_id: staffId, username: TEST_USER, role: 'admin' });
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin', adminRoutes);
});

afterAll(async () => {
  await pg.query(`DELETE FROM crm_persona_prompts WHERE name LIKE 'test_v%'`);
  await pg.query(`DELETE FROM staff_users WHERE id = $1`, [staffId]);
  await pg.end();
});

const auth = () => ({ Cookie: `crm_pilot_token=${token}` });

test('GET /personas lists all', async () => {
  const r = await request(app).get('/api/admin/personas').set(auth());
  expect(r.status).toBe(200);
  expect(r.body.items.find((p) => p.active)).toBeDefined();
});

test('POST /personas creates a new version (inactive by default)', async () => {
  const r = await request(app).post('/api/admin/personas').set(auth())
    .send({ name: `test_v${Date.now()}`, prompt_text: 'TEST PROMPT BODY' });
  expect(r.status).toBe(200);
  expect(r.body.id).toBeDefined();
  const row = await pg.query(`SELECT active FROM crm_persona_prompts WHERE id = $1`, [r.body.id]);
  expect(row.rows[0].active).toBe(false);
});

test('POST /personas/:id/activate flips active flag and deactivates others', async () => {
  const ins = await pg.query(
    `INSERT INTO crm_persona_prompts (name, prompt_text, active) VALUES ($1, 'X', false) RETURNING id`,
    [`test_v${Date.now()}_act`]
  );
  const newId = ins.rows[0].id;
  const r = await request(app).post(`/api/admin/personas/${newId}/activate`).set(auth());
  expect(r.status).toBe(200);
  const active = await pg.query(`SELECT id FROM crm_persona_prompts WHERE active = TRUE`);
  expect(active.rows).toHaveLength(1);
  expect(active.rows[0].id).toBe(newId);
});

test('GET /metrics/today returns numbers', async () => {
  const r = await request(app).get('/api/admin/metrics/today').set(auth());
  expect(r.status).toBe(200);
  expect(r.body.metrics).toEqual(expect.objectContaining({
    queue_depth: expect.any(Number),
    inbound_today: expect.any(Number),
    handovers_today: expect.any(Number),
  }));
});

test('POST /ai/global enables/disables global flag in process env', async () => {
  const r = await request(app).post('/api/admin/ai/global').set(auth()).send({ enabled: false });
  expect(r.status).toBe(200);
  expect(process.env.AI_GLOBAL_ENABLED).toBe('false');
  await request(app).post('/api/admin/ai/global').set(auth()).send({ enabled: true });
});
