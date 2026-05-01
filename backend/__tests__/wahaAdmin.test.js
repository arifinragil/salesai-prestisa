process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
process.env.WAHA_API_URL = 'http://waha.test';
process.env.WAHA_API_KEY = 'test-key';

global.fetch = jest.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const pg = require('../db/postgres');
const wahaAdminRoutes = require('../routes/wahaAdmin');
const { signToken } = require('../middleware/auth');
const { hashPassword } = require('../services/password');

const ADMIN_USER = `waha_admin_${Date.now()}`;
const STAFF_USER = `waha_staff_${Date.now()}`;
let adminToken, staffToken, app, adminId, staffId;

beforeAll(async () => {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS staff_users (
      id SERIAL PRIMARY KEY, username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL, full_name VARCHAR(100),
      role VARCHAR(20) DEFAULT 'staff', active BOOLEAN DEFAULT true,
      last_login_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`);
  const a = await pg.query(
    `INSERT INTO staff_users (username, password_hash, role) VALUES ($1, $2, 'admin') RETURNING id`,
    [ADMIN_USER, hashPassword('x')]);
  adminId = a.rows[0].id;
  const s = await pg.query(
    `INSERT INTO staff_users (username, password_hash, role) VALUES ($1, $2, 'staff') RETURNING id`,
    [STAFF_USER, hashPassword('x')]);
  staffId = s.rows[0].id;
  adminToken = signToken({ staff_id: adminId, username: ADMIN_USER, role: 'admin' });
  staffToken = signToken({ staff_id: staffId, username: STAFF_USER, role: 'staff' });

  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/waha', wahaAdminRoutes);
});

afterAll(async () => {
  await pg.query(`DELETE FROM staff_users WHERE id = ANY($1)`, [[adminId, staffId]]);
  await pg.end();
});

beforeEach(() => { fetch.mockReset(); });

const adminAuth = () => ({ Cookie: `crm_pilot_token=${adminToken}` });
const staffAuth = () => ({ Cookie: `crm_pilot_token=${staffToken}` });

function mockJsonResponse(body, status = 200) {
  fetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
    headers: { get: () => 'application/json' },
  });
}

test('GET /sessions requires admin role (staff = 403)', async () => {
  const r = await request(app).get('/api/admin/waha/sessions').set(staffAuth());
  expect(r.status).toBe(403);
});

test('GET /sessions returns proxied list', async () => {
  mockJsonResponse([
    { name: 'tiara-pilot', status: 'WORKING', engine: { engine: 'WEBJS' } },
    { name: 'backup', status: 'STOPPED' },
  ]);
  const r = await request(app).get('/api/admin/waha/sessions').set(adminAuth());
  expect(r.status).toBe(200);
  expect(r.body.success).toBe(true);
  expect(r.body.sessions).toHaveLength(2);
  expect(fetch).toHaveBeenCalledWith(
    'http://waha.test/api/sessions',
    expect.objectContaining({ headers: expect.objectContaining({ 'X-Api-Key': 'test-key' }) })
  );
});

test('POST /sessions creates and starts new session', async () => {
  mockJsonResponse({ name: 'pilot-2', status: 'STARTING' }, 201);
  mockJsonResponse({ ok: true });
  const r = await request(app).post('/api/admin/waha/sessions').set(adminAuth())
    .send({ name: 'pilot-2' });
  expect(r.status).toBe(200);
  expect(r.body.success).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][0]).toBe('http://waha.test/api/sessions');
  expect(fetch.mock.calls[1][0]).toBe('http://waha.test/api/sessions/pilot-2/start');
});

test('POST /sessions rejects invalid name', async () => {
  const r = await request(app).post('/api/admin/waha/sessions').set(adminAuth())
    .send({ name: 'bad name with space' });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/name/);
  expect(fetch).not.toHaveBeenCalled();
});

test('GET /sessions/:name returns details', async () => {
  mockJsonResponse({ name: 'tiara-pilot', status: 'SCAN_QR_CODE', me: null });
  const r = await request(app).get('/api/admin/waha/sessions/tiara-pilot').set(adminAuth());
  expect(r.status).toBe(200);
  expect(r.body.session.status).toBe('SCAN_QR_CODE');
});

test('GET /sessions/:name/qr proxies binary PNG', async () => {
  fetch.mockResolvedValueOnce({
    ok: true, status: 200,
    arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
    headers: { get: (h) => (h === 'content-type' ? 'image/png' : null) },
  });
  const r = await request(app).get('/api/admin/waha/sessions/tiara-pilot/qr').set(adminAuth());
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toMatch(/image\/png/);
  expect(r.body.length).toBe(4);
});

test('GET /qr returns 409 when session not in SCAN_QR_CODE', async () => {
  fetch.mockResolvedValueOnce({
    ok: false, status: 422,
    json: async () => ({ message: 'Session is not in SCAN_QR_CODE state' }),
    text: async () => 'Session is not in SCAN_QR_CODE state',
    headers: { get: () => 'application/json' },
  });
  const r = await request(app).get('/api/admin/waha/sessions/tiara-pilot/qr').set(adminAuth());
  expect(r.status).toBe(409);
  expect(r.body.message).toMatch(/SCAN_QR_CODE/);
});

test('POST /sessions/:name/stop proxies', async () => {
  mockJsonResponse({ ok: true });
  const r = await request(app).post('/api/admin/waha/sessions/tiara-pilot/stop').set(adminAuth());
  expect(r.status).toBe(200);
  expect(fetch).toHaveBeenCalledWith(
    'http://waha.test/api/sessions/tiara-pilot/stop',
    expect.objectContaining({ method: 'POST' })
  );
});

test('POST /sessions/:name/restart proxies', async () => {
  mockJsonResponse({ ok: true });
  const r = await request(app).post('/api/admin/waha/sessions/tiara-pilot/restart').set(adminAuth());
  expect(r.status).toBe(200);
});

test('DELETE /sessions/:name proxies and rejects active env session', async () => {
  process.env.WAHA_SESSION = 'tiara-pilot';
  const r = await request(app).delete('/api/admin/waha/sessions/tiara-pilot').set(adminAuth());
  expect(r.status).toBe(409);
  expect(r.body.message).toMatch(/active session/i);

  mockJsonResponse({ ok: true });
  const r2 = await request(app).delete('/api/admin/waha/sessions/other-session').set(adminAuth());
  expect(r2.status).toBe(200);
  expect(fetch).toHaveBeenCalledWith(
    'http://waha.test/api/sessions/other-session',
    expect.objectContaining({ method: 'DELETE' })
  );
});

test('upstream WAHA error surfaced with detail', async () => {
  fetch.mockResolvedValueOnce({
    ok: false, status: 500,
    json: async () => ({ message: 'WAHA boom' }),
    text: async () => 'WAHA boom',
    headers: { get: () => 'application/json' },
  });
  const r = await request(app).get('/api/admin/waha/sessions').set(adminAuth());
  expect(r.status).toBe(502);
  expect(r.body.upstream_status).toBe(500);
});
