// backend/scripts/leadTempDecay.js
// Every 5 min: recompute lead temperature for all active convs.
// Cheap: rule-based, sub-50ms each. Limit batch to keep run < 1 min total.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const leadTemp = require('../services/leadTemperature');
const logger = require('../services/logger');

const BATCH_LIMIT = 200;

async function run() {
  const r = await pg.query(
    `SELECT id FROM crm_conversations
     WHERE status = 'active' AND last_message_at > now() - interval '7 days'
     ORDER BY last_message_at DESC
     LIMIT $1`,
    [BATCH_LIMIT]
  );
  let scanned = 0, updated = 0, errors = 0;
  for (const row of r.rows) {
    scanned++;
    try {
      await leadTemp.compute(row.id);
      updated++;
    } catch (err) {
      errors++;
      logger.warn({ err: err.message, conv_id: row.id }, '[leadTempDecay] compute failed');
    }
  }
  logger.info({ scanned, updated, errors }, '[leadTempDecay] done');
  await pg.end();
  await mysql.end();
}

if (require.main === module) {
  run().catch((err) => {
    logger.error({ err: err.message }, '[leadTempDecay] failed');
    process.exit(1);
  });
}
module.exports = { run };
