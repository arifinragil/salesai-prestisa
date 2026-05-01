process.env.WAHA_WEBHOOK_SECRET = 'test-secret';
process.env.WA_PROVIDER = 'waha';

jest.mock('../services/contactResolver', () => ({
  jidToPhone: jest.fn((jid) => String(jid).split('@')[0]),
  normalizePhone: jest.fn((p) => p),
  resolveByPhone: jest.fn().mockResolvedValue({ customer_id: 7, name: 'Test Cust' }),
}));

const express = require('express');
const request = require('supertest');
const pg = require('../db/postgres');
const webhookRoutes = require('../routes/webhook');

let app;
const TEST_PHONE = `62888${Date.now() % 100000000}`;

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/webhook', webhookRoutes);
});

afterAll(async () => {
  await pg.query(
    `DELETE FROM crm_inbound_queue
       WHERE conversation_id IN (SELECT id FROM crm_conversations WHERE phone = $1)`,
    [TEST_PHONE]
  );
  await pg.query(`DELETE FROM crm_messages
                  WHERE conversation_id IN (SELECT id FROM crm_conversations WHERE phone = $1)`,
                 [TEST_PHONE]);
  await pg.query(`DELETE FROM crm_conversations WHERE phone = $1`, [TEST_PHONE]);
  await pg.end();
});

test('rejects without webhook secret', async () => {
  const r = await request(app).post('/webhook/waha').send({ wa_jid: `${TEST_PHONE}@c.us`, body: 'hi' });
  expect(r.status).toBe(401);
});

test('skips group jids', async () => {
  const r = await request(app).post('/webhook/waha')
    .set('X-Webhook-Secret', 'test-secret')
    .send({ wa_jid: '120@g.us', body: 'hi' });
  expect(r.status).toBe(200);
  expect(r.body.skipped).toBe('group');
});

test('inserts message + queue row, returns conversation_id', async () => {
  const r = await request(app).post('/webhook/waha')
    .set('X-Webhook-Secret', 'test-secret')
    .send({ wa_jid: `${TEST_PHONE}@c.us`, push_name: 'Test', body: 'mau pesan papan',
            waha_message_id: `tmid-${Date.now()}` });
  expect(r.status).toBe(200);
  expect(r.body.success).toBe(true);
  expect(r.body.conversation_id).toBeDefined();

  const conv = await pg.query(`SELECT * FROM crm_conversations WHERE phone = $1`, [TEST_PHONE]);
  expect(conv.rows[0].customer_id).toBe(7);

  const msg = await pg.query(
    `SELECT * FROM crm_messages WHERE conversation_id = $1 AND direction = 'in'`,
    [r.body.conversation_id]
  );
  expect(msg.rows[0].body).toBe('mau pesan papan');

  const q = await pg.query(
    `SELECT * FROM crm_inbound_queue WHERE conversation_id = $1`, [r.body.conversation_id]
  );
  expect(q.rows[0].status).toBe('pending');
});

test('idempotent on duplicate waha_message_id (no second queue row)', async () => {
  const dupId = `dup-${Date.now()}`;
  const r1 = await request(app).post('/webhook/waha')
    .set('X-Webhook-Secret', 'test-secret')
    .send({ wa_jid: `${TEST_PHONE}@c.us`, body: 'first', waha_message_id: dupId });
  expect(r1.body.success).toBe(true);

  const r2 = await request(app).post('/webhook/waha')
    .set('X-Webhook-Secret', 'test-secret')
    .send({ wa_jid: `${TEST_PHONE}@c.us`, body: 'first-again', waha_message_id: dupId });
  expect(r2.status).toBe(200);
  expect(r2.body.duplicate).toBe(true);

  const q = await pg.query(
    `SELECT COUNT(*)::int AS n FROM crm_messages WHERE waha_message_id = $1`, [dupId]
  );
  expect(q.rows[0].n).toBe(1);
});

test('non-text (media) → enqueues for handover decision in worker', async () => {
  const r = await request(app).post('/webhook/waha')
    .set('X-Webhook-Secret', 'test-secret')
    .send({ wa_jid: `${TEST_PHONE}@c.us`, body: null, media_url: 'https://x/y.jpg',
            media_mimetype: 'image/jpeg', waha_message_id: `media-${Date.now()}` });
  expect(r.body.success).toBe(true);
  const msg = await pg.query(
    `SELECT * FROM crm_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`,
    [r.body.conversation_id]
  );
  expect(msg.rows[0].message_type).toBe('media');
  expect(msg.rows[0].attachment_url).toBe('https://x/y.jpg');
});
