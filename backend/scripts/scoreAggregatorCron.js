// backend/scripts/scoreAggregatorCron.js
// Nightly: aggregate yesterday's daily scores. Runs at 01:00 WIB (18:00 UTC
// previous day) so all metrics for the previous WIB day are stable.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const aggr = require('../services/scoreAggregator');
const logger = require('../services/logger');

function wibDateStr(offsetDays = 0) {
  const now = new Date();
  const wib = new Date(now.getTime() + 7 * 3600_000 + offsetDays * 24 * 3600_000);
  return wib.toISOString().slice(0, 10);
}

async function run() {
  const yesterday = wibDateStr(-1);
  const today = wibDateStr(0);
  const yResult = await aggr.computeForDate(yesterday);
  const tResult = await aggr.computeForDate(today);
  logger.info({ yesterday, yesterday_written: yResult.written, today, today_written: tResult.written },
    '[scoreAggregatorCron] done');
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[scoreAggregatorCron] failed'); process.exit(1); });
}
