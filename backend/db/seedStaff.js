require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pool = require('./postgres');
const { hashPassword } = require('../services/password');

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS staff_users (
        id            SERIAL PRIMARY KEY,
        username      VARCHAR(50) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        full_name     VARCHAR(100),
        role          VARCHAR(20) DEFAULT 'staff',
        active        BOOLEAN DEFAULT true,
        last_login_at TIMESTAMPTZ,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    const seedUser = process.env.CRM_SEED_USERNAME || 'finance';
    const seedPass = process.env.CRM_SEED_PASSWORD || 'Bunga123';
    const existing = await client.query(`SELECT id FROM staff_users WHERE username = $1`, [seedUser]);
    if (existing.rowCount === 0) {
      await client.query(
        `INSERT INTO staff_users (username, password_hash, full_name, role)
         VALUES ($1, $2, $3, 'admin')`,
        [seedUser, hashPassword(seedPass), 'Finance Prestisa']
      );
      console.log(`[seedStaff] seeded admin: ${seedUser}`);
    } else {
      console.log(`[seedStaff] admin '${seedUser}' already exists`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  run().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { run };
