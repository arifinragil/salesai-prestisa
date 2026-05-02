// backend/scripts/backfillLeadTemperature.js
// One-shot: compute lead_temperature + lead_score for all convs with activity in last 30d.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const leadTemp = require('../services/leadTemperature');
const logger = require('../services/logger');

async function run() {
  const r = await pg.query(
    `SELECT id FROM crm_conversations
     WHERE last_message_at > now() - interval '30 days'
     ORDER BY last_message_at DESC`
  );
  let i = 0, errors = 0;
  for (const row of r.rows) {
    try {
      await leadTemp.compute(row.id);
      i++;
      if (i % 50 === 0) logger.info({ done: i, total: r.rows.length }, '[backfillLeadTemp] progress');
    } catch (err) {
      errors++;
      logger.warn({ err: err.message, conv_id: row.id }, '[backfillLeadTemp] compute failed');
    }
  }
  logger.info({ total: r.rows.length, ok: i, errors }, '[backfillLeadTemp] done');
  await pg.end();
  await mysql.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[backfillLeadTemp] failed'); process.exit(1); });
}
