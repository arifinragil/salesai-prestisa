// backend/scripts/b2bTickCron.js
// Every 15 min: advance B2B campaign sequences (queue next step for due prospects).
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const b2b = require('../services/b2bOutreach');
const logger = require('../services/logger');

async function run() {
  await b2b.tick();
  await pg.end();
  await mysql.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[b2bTickCron] failed'); process.exit(1); });
}
