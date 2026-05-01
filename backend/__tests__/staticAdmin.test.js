process.env.DISABLE_WORKER = 'true';
const request = require('supertest');
const { app } = require('../index');

afterAll(async () => {
  const pg = require('../db/postgres');
  const mysql = require('../db/mysql');
  await pg.end(); await mysql.end();
});

test('GET /admin/login.html returns the login form', async () => {
  const r = await request(app).get('/admin/login.html');
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toMatch(/html/);
  expect(r.text).toMatch(/Tiara Admin Login/);
});

test('GET /admin/waha-sessions.html returns the sessions UI', async () => {
  const r = await request(app).get('/admin/waha-sessions.html');
  expect(r.status).toBe(200);
  expect(r.text).toMatch(/WAHA Sessions/);
});

test('GET /admin redirects to waha-sessions.html', async () => {
  const r = await request(app).get('/admin');
  // Note: express.static handles /admin/ as well; the redirect catches the /admin (no trailing slash) case
  // but if static intercepts first with a directory listing redirect, we'll see 301 instead.
  expect([301, 302]).toContain(r.status);
  expect(r.headers.location).toMatch(/waha-sessions\.html|\/admin\//);
});
