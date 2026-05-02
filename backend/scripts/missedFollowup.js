// backend/scripts/missedFollowup.js
// Every 5 min: evaluate batch red flags (slow_first_response, missed_followup,
// suggestion_deviation, manual_override_high, lost_no_reason, csat_low,
// handover_overuse).
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const det = require('../services/redFlagDetector');
const logger = require('../services/logger');

async function run() {
  const candidates = await det.evaluateBatch();
  const inserted = await det.record(candidates);
  logger.info({ candidates: candidates.length, inserted }, '[missedFollowup] done');
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[missedFollowup] failed'); process.exit(1); });
}
module.exports = { run };
