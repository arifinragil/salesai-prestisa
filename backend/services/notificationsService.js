// Notifications domain — insert + read state.
const pg = require('../db/postgres');
const tg = require('./telegramNotify');
const logger = require('./logger');

async function notify(staffId, kind, title, opts = {}) {
  const r = await pg.query(
    `INSERT INTO crm_notifications (staff_id, kind, title, body, link, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
    [staffId, kind, title, opts.body || null, opts.link || null, JSON.stringify(opts.payload || {})]
  );
  // Best-effort personal Telegram if opted in
  if (opts.sendTelegram !== false) {
    try {
      const lookup = await pg.query(`SELECT telegram_chat_id FROM staff_users WHERE id = $1`, [staffId]);
      const chatId = lookup.rows[0]?.telegram_chat_id;
      if (chatId) {
        const tgBody = `<b>${title}</b>${opts.body ? '\n' + opts.body : ''}${opts.link ? '\n' + opts.link : ''}`;
        await tg.send(tgBody, { _overrideChatId: chatId });
      }
    } catch (err) {
      logger.warn({ err: err.message, staffId }, '[notifications] telegram personal failed');
    }
  }
  return { id: r.rows[0].id };
}

async function markRead(id, staffId) {
  await pg.query(
    `UPDATE crm_notifications SET read_at = now() WHERE id = $1 AND staff_id = $2 AND read_at IS NULL`,
    [id, staffId]
  );
}

async function markAllRead(staffId) {
  const r = await pg.query(
    `UPDATE crm_notifications SET read_at = now() WHERE staff_id = $1 AND read_at IS NULL`,
    [staffId]
  );
  return r.rowCount;
}

async function unreadCount(staffId) {
  const { rows } = await pg.query(
    `SELECT COUNT(*)::int AS n FROM crm_notifications WHERE staff_id = $1 AND read_at IS NULL`,
    [staffId]
  );
  return rows[0].n;
}

async function list(staffId, opts = {}) {
  const limit = Math.min(opts.limit || 20, 100);
  const where = ['staff_id = $1'];
  const params = [staffId];
  if (opts.unreadOnly) where.push('read_at IS NULL');
  const { rows } = await pg.query(
    `SELECT id, kind, title, body, link, payload, read_at, created_at
     FROM crm_notifications WHERE ${where.join(' AND ')}
     ORDER BY id DESC LIMIT ${limit}`,
    params
  );
  return rows;
}

module.exports = { notify, markRead, markAllRead, unreadCount, list };
