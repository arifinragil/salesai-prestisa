require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const pool = require('./postgres');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS crm_migrations (
      id          SERIAL PRIMARY KEY,
      filename    VARCHAR(128) NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getApplied(client) {
  const { rows } = await client.query(`SELECT filename FROM crm_migrations`);
  return new Set(rows.map((r) => r.filename));
}

async function applyOne(client, file, sql) {
  await client.query(sql);
  await client.query(`INSERT INTO crm_migrations (filename) VALUES ($1)`, [file]);
}

async function run() {
  const dir = path.join(__dirname, '../migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getApplied(client);

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[migrate] skip ${file} (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      console.log(`[migrate] applying ${file}...`);
      await applyOne(client, file, sql);
      console.log(`[migrate] applied ${file}`);
    }
    console.log('[migrate] done.');
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  run().catch((err) => { console.error('[migrate] FAILED:', err); process.exit(1); });
}

module.exports = { run };
