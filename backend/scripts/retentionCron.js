// backend/scripts/retentionCron.js
// Daily 09:00 WIB: dormant + winback + moments retention engine.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const engine = require('../services/retentionEngine');
const logger = require('../services/logger');

async function run() {
  await engine.run();
  await pg.end();
  await mysql.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message, stack: err.stack }, '[retentionCron] failed'); process.exit(1); });
}
