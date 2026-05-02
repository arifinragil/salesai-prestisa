// Task reminder cron — every 5 min.
// 1) Due reminder: tasks active, reminder_sent_at NULL, due_at within next hour.
// 2) Overdue reminder: tasks active, due_at >24h ago, overdue_sent_at NULL.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const notif = require('../services/notificationsService');
const logger = require('../services/logger');

async function processDue() {
  const { rows } = await pg.query(
    `SELECT t.id, t.owner_id, t.title, t.body, t.due_at, t.conversation_id
     FROM crm_tasks t
     JOIN staff_users u ON u.id = t.owner_id
     WHERE t.status IN ('open','in_progress')
       AND t.reminder_sent_at IS NULL
       AND t.due_at IS NOT NULL
       AND t.due_at <= now() + interval '1 hour'
       AND t.due_at >= now() - interval '24 hours'
       AND u.active = TRUE AND u.disabled_at IS NULL
     ORDER BY t.due_at ASC LIMIT 100`
  );
  let sent = 0;
  for (const t of rows) {
    try {
      await notif.notify(t.owner_id, 'task_due', `⏰ Task due: ${t.title}`, {
        body: t.body?.slice(0, 200) || '',
        link: t.conversation_id ? `/inbox/${t.conversation_id}` : `/tasks?focus=${t.id}`,
        payload: { task_id: t.id, due_at: t.due_at },
      });
      await pg.query(`UPDATE crm_tasks SET reminder_sent_at = now() WHERE id = $1`, [t.id]);
      sent++;
    } catch (err) { logger.warn({ err: err.message, task_id: t.id }, '[task-reminder] due failed'); }
  }
  return sent;
}

async function processOverdue() {
  const { rows } = await pg.query(
    `SELECT t.id, t.owner_id, t.title, t.due_at, t.conversation_id
     FROM crm_tasks t
     JOIN staff_users u ON u.id = t.owner_id
     WHERE t.status IN ('open','in_progress')
       AND t.due_at < now() - interval '24 hours'
       AND t.overdue_sent_at IS NULL
       AND u.active = TRUE AND u.disabled_at IS NULL
     ORDER BY t.due_at ASC LIMIT 100`
  );
  let sent = 0;
  for (const t of rows) {
    try {
      await notif.notify(t.owner_id, 'task_overdue', `🚨 Task overdue: ${t.title}`, {
        link: t.conversation_id ? `/inbox/${t.conversation_id}` : `/tasks?focus=${t.id}`,
        payload: { task_id: t.id, due_at: t.due_at },
      });
      await pg.query(`UPDATE crm_tasks SET overdue_sent_at = now() WHERE id = $1`, [t.id]);
      sent++;
    } catch (err) { logger.warn({ err: err.message, task_id: t.id }, '[task-reminder] overdue failed'); }
  }
  return sent;
}

async function run() {
  const due = await processDue();
  const overdue = await processOverdue();
  logger.info({ due_sent: due, overdue_sent: overdue }, '[task-reminder] done');
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[task-reminder] failed'); process.exit(1); });
}
module.exports = { run };
