require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.LOTUS_PG_HOST || process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.LOTUS_PG_PORT) || 5432,
  database: process.env.LOTUS_PG_DATABASE || 'lotus_conversations',
  user: process.env.LOTUS_PG_USER || 'lotus_sync',
  password: process.env.LOTUS_PG_PASSWORD,
  max: parseInt(process.env.LOTUS_PG_POOL_MAX) || 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

module.exports = pool;
