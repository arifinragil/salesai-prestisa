// Pipeline watcher — every hour. Auto-Lost stale deals:
//   stage in (tertarik, form_dikirim) + last_message_at < now - 3 days → lost
//   stage = baru + last_message_at < now - 7 days → lost
// Skips conversations currently snoozed (snoozed_until > now()).
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const engine = require('../services/pipelineEngine');
const logger = require('../services/logger');

async function processStale(stages, daysThreshold, eventType) {
  const { rows } = await pg.query(
    `SELECT id FROM crm_conversations
     WHERE pipeline_stage = ANY($1::varchar[])
       AND COALESCE(snoozed_until, '1970-01-01'::timestamptz) < now()
       AND last_message_at < now() - ($2 || ' days')::interval`,
    [stages, String(daysThreshold)]
  );
  let lost = 0;
  for (const r of rows) {
    try {
      const result = await engine.apply(pg, r.id, { type: eventType }, {
        source: 'auto:stale_watcher',
        lostReason: 'no_reply',
      });
      if (result.applied) lost++;
    } catch (err) {
      logger.warn({ err: err.message, conv_id: r.id }, '[watcher] one failed');
    }
  }
  return lost;
}

async function run() {
  const lost1 = await processStale(['tertarik', 'form_dikirim'], 3, 'stale_no_reply');
  const lost2 = await processStale(['baru'], 7, 'stale_baru_no_reply');
  logger.info({ lost_active: lost1, lost_baru: lost2 }, '[watcher] done');
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[watcher] failed'); process.exit(1); });
}

module.exports = { run };
