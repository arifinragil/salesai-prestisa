const pg = require('../db/postgres');
const { rollupForDate } = require('../scripts/dailyMetricsRollup');

const TEST_PHONE = `62555${Date.now() % 10000000}`;
const TEST_DATE = '2026-04-15';

afterAll(async () => {
  await pg.query(`DELETE FROM crm_handovers WHERE conversation_id IN
    (SELECT id FROM crm_conversations WHERE phone = $1)`, [TEST_PHONE]);
  await pg.query(`DELETE FROM crm_messages WHERE conversation_id IN
    (SELECT id FROM crm_conversations WHERE phone = $1)`, [TEST_PHONE]);
  await pg.query(`DELETE FROM crm_conversations WHERE phone = $1`, [TEST_PHONE]);
  await pg.query(`DELETE FROM crm_ai_metrics_daily WHERE date = $1`, [TEST_DATE]);
  await pg.end();
});

test('rollup aggregates inbound, ai-sent, handovers, tokens for the date', async () => {
  const conv = await pg.query(
    `INSERT INTO crm_conversations (phone, last_message_at) VALUES ($1, $2) RETURNING id`,
    [TEST_PHONE, `${TEST_DATE} 12:00:00+07`]
  );
  const convId = conv.rows[0].id;
  await pg.query(
    `INSERT INTO crm_messages (conversation_id, direction, sender_type, body, created_at)
     VALUES ($1, 'in', 'customer', 'hi', $2),
            ($1, 'out', 'ai', 'halo', $3),
            ($1, 'out', 'ai', 'oke', $3)`,
    [convId, `${TEST_DATE} 12:00:01+07`, `${TEST_DATE} 12:00:02+07`]
  );
  await pg.query(
    `UPDATE crm_messages SET ai_metadata = '{"latency_ms":1500,"tokens_in":100,"tokens_out":20}'::jsonb
     WHERE conversation_id = $1 AND sender_type = 'ai'`, [convId]
  );
  await pg.query(
    `INSERT INTO crm_handovers (conversation_id, reason, created_at) VALUES ($1, 'complaint', $2)`,
    [convId, `${TEST_DATE} 13:00:00+07`]
  );

  await rollupForDate(TEST_DATE);

  const r = await pg.query(`SELECT * FROM crm_ai_metrics_daily WHERE date = $1`, [TEST_DATE]);
  const row = r.rows[0];
  expect(row.total_inbound).toBe(1);
  expect(row.total_ai_sent).toBe(2);
  expect(row.total_handovers).toBe(1);
  expect(row.unique_conversations).toBe(1);
  expect(String(row.total_tokens_in)).toBe('200');
  expect(row.handover_breakdown).toEqual({ complaint: 1 });
  expect(parseFloat(row.cost_usd)).toBeGreaterThan(0);
});

test('idempotent: re-rolling same date overwrites', async () => {
  await rollupForDate(TEST_DATE);
  await rollupForDate(TEST_DATE);
  const r = await pg.query(`SELECT COUNT(*)::int AS n FROM crm_ai_metrics_daily WHERE date = $1`, [TEST_DATE]);
  expect(r.rows[0].n).toBe(1);
});
