// backend/scripts/prune.js
// Daily: prune old log/audit data per spec NFR-A4/A5.
//   crm_suggestion_log: 90d
//   crm_agent_red_flags: 365d (resolved or unresolved)
//   crm_hot_lead_alerts: 90d
//   crm_link_events:     90d
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const logger = require('../services/logger');

const TARGETS = [
  { table: 'crm_suggestion_log',   col: 'shown_at',    days: 90 },
  { table: 'crm_agent_red_flags',  col: 'detected_at', days: 365 },
  { table: 'crm_hot_lead_alerts',  col: 'sent_at',     days: 90 },
  { table: 'crm_link_events',      col: 'created_at',  days: 90 },
];

async function run() {
  const summary = {};
  for (const t of TARGETS) {
    try {
      const r = await pg.query(
        `DELETE FROM ${t.table} WHERE ${t.col} < now() - ($1 || ' days')::interval`,
        [String(t.days)]
      );
      summary[t.table] = r.rowCount;
    } catch (err) {
      logger.warn({ err: err.message, table: t.table }, '[prune] delete failed');
      summary[t.table] = `error: ${err.message}`;
    }
  }
  logger.info(summary, '[prune] done');
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[prune] failed'); process.exit(1); });
}
module.exports = { run };
