process.env.WAHA_WEBHOOK_SECRET = 'test-secret';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';

jest.mock('../services/waAdapters/wahaAdapter', () => ({
  name: 'waha',
  // Unique id per call to avoid waha_message_id UNIQUE collisions across test runs
  sendText: jest.fn().mockImplementation(() => Promise.resolve({ id: `manual-${Date.now()}-${Math.random().toString(36).slice(2,8)}` })),
  parseInbound: jest.fn(),
}));

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const pg = require('../db/postgres');
const inboxRoutes = require('../routes/inbox');
const wahaAdapter = require('../services/waAdapters/wahaAdapter');
const { signToken } = require('../middleware/auth');
const { hashPassword } = require('../services/password');

const TEST_PHONE = `62666${Date.now() % 10000000}`;
const TEST_USER = `inbox_test_${Date.now()}`;
let staffId;
let token;
let app;

beforeAll(async () => {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS staff_users (
      id SERIAL PRIMARY KEY, username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL, full_name VARCHAR(100),
      role VARCHAR(20) DEFAULT 'staff', active BOOLEAN DEFAULT true,
      last_login_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`);
  const u = await pg.query(
    `INSERT INTO staff_users (username, password_hash, role) VALUES ($1, $2, 'admin') RETURNING id`,
    [TEST_USER, hashPassword('x')]
  );
  staffId = u.rows[0].id;
  token = signToken({ staff_id: staffId, username: TEST_USER, role: 'admin' });

  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/inbox', inboxRoutes);
});

afterAll(async () => {
  await pg.query(`DELETE FROM crm_handovers
    WHERE conversation_id IN (SELECT id FROM crm_conversations WHERE phone = $1)`, [TEST_PHONE]);
  await pg.query(`DELETE FROM crm_messages
    WHERE conversation_id IN (SELECT id FROM crm_conversations WHERE phone = $1)`, [TEST_PHONE]);
  await pg.query(`DELETE FROM crm_conversations WHERE phone = $1`, [TEST_PHONE]);
  await pg.query(`DELETE FROM staff_users WHERE id = $1`, [staffId]);
  await pg.end();
});

async function seedConv() {
  const c = await pg.query(
    `INSERT INTO crm_conversations (phone, last_message_at) VALUES ($1, now())
     ON CONFLICT (phone) DO UPDATE SET last_message_at = now() RETURNING id`,
    [TEST_PHONE]
  );
  const convId = c.rows[0].id;
  await pg.query(
    `INSERT INTO crm_messages (conversation_id, direction, sender_type, body)
     VALUES ($1, 'in', 'customer', 'halo')`, [convId]);
  return convId;
}

const auth = () => ({ Cookie: `crm_pilot_token=${token}` });

test('GET /conversations requires auth', async () => {
  const r = await request(app).get('/api/inbox/conversations');
  expect(r.status).toBe(401);
});

test('GET /conversations returns list with last message', async () => {
  await seedConv();
  const r = await request(app).get('/api/inbox/conversations').set(auth());
  expect(r.status).toBe(200);
  expect(r.body.success).toBe(true);
  expect(r.body.items.length).toBeGreaterThan(0);
  const ours = r.body.items.find((i) => i.phone === TEST_PHONE);
  expect(ours).toBeDefined();
  expect(ours.last_body).toBe('halo');
});

test('GET /conversations/:id/messages returns history', async () => {
  const convId = await seedConv();
  const r = await request(app).get(`/api/inbox/conversations/${convId}/messages`).set(auth());
  expect(r.status).toBe(200);
  expect(r.body.messages.length).toBeGreaterThan(0);
});

test('POST /conversations/:id/send sends manual message and stores as staff', async () => {
  const convId = await seedConv();
  const r = await request(app)
    .post(`/api/inbox/conversations/${convId}/send`)
    .set(auth())
    .send({ body: 'manual reply from operator' });
  expect(r.status).toBe(200);
  expect(r.body.success).toBe(true);
  expect(wahaAdapter.sendText).toHaveBeenCalledWith(expect.objectContaining({ phone: TEST_PHONE, text: 'manual reply from operator' }));

  const out = await pg.query(
    `SELECT * FROM crm_messages WHERE conversation_id = $1 AND sender_type = 'staff' ORDER BY id DESC LIMIT 1`,
    [convId]
  );
  expect(out.rows[0].body).toBe('manual reply from operator');
  expect(out.rows[0].staff_id).toBe(staffId);
});

test('POST /conversations/:id/takeover pauses AI and assigns staff', async () => {
  const convId = await seedConv();
  const r = await request(app)
    .post(`/api/inbox/conversations/${convId}/takeover`)
    .set(auth());
  expect(r.status).toBe(200);
  const conv = await pg.query(`SELECT ai_paused_until, assigned_staff_id FROM crm_conversations WHERE id = $1`, [convId]);
  expect(conv.rows[0].ai_paused_until).not.toBeNull();
  expect(conv.rows[0].assigned_staff_id).toBe(staffId);
});

test('POST /conversations/:id/resume-ai clears pause', async () => {
  const convId = await seedConv();
  await pg.query(`UPDATE crm_conversations SET ai_paused_until = now() + INTERVAL '1 hour' WHERE id = $1`, [convId]);
  const r = await request(app).post(`/api/inbox/conversations/${convId}/resume-ai`).set(auth());
  expect(r.status).toBe(200);
  const conv = await pg.query(`SELECT ai_paused_until FROM crm_conversations WHERE id = $1`, [convId]);
  expect(conv.rows[0].ai_paused_until).toBeNull();
});

test('GET /handovers returns unresolved list', async () => {
  const convId = await seedConv();
  await pg.query(`INSERT INTO crm_handovers (conversation_id, reason, detail) VALUES ($1, 'complaint', 'test')`, [convId]);
  const r = await request(app).get('/api/inbox/handovers').set(auth());
  expect(r.status).toBe(200);
  expect(r.body.items.find((h) => h.conversation_id === convId)).toBeDefined();
});

test('POST /handovers/:id/resolve marks handover resolved', async () => {
  const convId = await seedConv();
  const ho = await pg.query(`INSERT INTO crm_handovers (conversation_id, reason, detail) VALUES ($1, 'complaint', 'test') RETURNING id`, [convId]);
  const r = await request(app).post(`/api/inbox/handovers/${ho.rows[0].id}/resolve`).set(auth());
  expect(r.status).toBe(200);
  const after = await pg.query(`SELECT resolved_at, resolved_by FROM crm_handovers WHERE id = $1`, [ho.rows[0].id]);
  expect(after.rows[0].resolved_at).not.toBeNull();
  expect(after.rows[0].resolved_by).toBe(staffId);
});
