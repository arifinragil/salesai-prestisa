const fs = require('fs');
const path = require('path');
const pg = require('../db/postgres');

afterAll(async () => { await pg.end(); });

const expectedTables = [
  'crm_conversations', 'crm_messages', 'crm_inbound_queue',
  'crm_handovers', 'crm_ai_metrics_daily', 'crm_persona_prompts',
  'crm_promo_settings', 'crm_migrations',
];

test('migration files exist', () => {
  const dir = path.join(__dirname, '../migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  expect(files).toContain('001_init.sql');
  expect(files).toContain('002_seed_persona.sql');
});

test('all crm_* tables present after migration', async () => {
  const { rows } = await pg.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name LIKE 'crm_%'
     ORDER BY table_name`
  );
  const names = rows.map((r) => r.table_name);
  for (const t of expectedTables) {
    expect(names).toContain(t);
  }
});

test('persona seed loaded — at least one active prompt', async () => {
  const { rows } = await pg.query(
    `SELECT name FROM crm_persona_prompts WHERE active = TRUE`
  );
  expect(rows.length).toBeGreaterThanOrEqual(1);
  expect(rows[0].name).toMatch(/tiara/i);
});
