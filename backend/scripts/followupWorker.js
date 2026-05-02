// Followup worker — runs every 5 minutes via cron. Picks due followups,
// validates "still relevant" (e.g. order_url_pending → no order arrived since,
// no inbound from customer), sends body via WAHA, marks sent.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const waClient = require('../services/waClient');
const logger = require('../services/logger');

async function runOne(fu) {
  // Cancel if conv was opted-out / closed / AI off
  const { rows: convRows } = await pg.query(
    `SELECT id, phone, wa_session, status, ai_enabled, ai_paused_until,
            last_message_at, last_order_url_ref
     FROM crm_conversations WHERE id = $1`, [fu.conversation_id]
  );
  const conv = convRows[0];
  if (!conv) {
    await pg.query(`UPDATE crm_followups SET status='cancelled', cancel_reason='conv_missing', cancelled_at=now() WHERE id=$1`, [fu.id]);
    return { id: fu.id, action: 'cancel:conv_missing' };
  }
  if (conv.status === 'closed' || !conv.ai_enabled) {
    await pg.query(`UPDATE crm_followups SET status='cancelled', cancel_reason='conv_closed_or_ai_off', cancelled_at=now() WHERE id=$1`, [fu.id]);
    return { id: fu.id, action: 'cancel:conv_off' };
  }

  // Kind-specific relevance check
  if (fu.kind === 'order_url_pending') {
    // Skip if customer sent any new inbound after url_sent_at (means they're engaged)
    const since = await pg.query(
      `SELECT COUNT(*) AS n FROM crm_messages
       WHERE conversation_id = $1 AND direction = 'in'
         AND created_at > (SELECT last_order_url_sent_at FROM crm_conversations WHERE id = $1)`,
      [fu.conversation_id]
    );
    if (Number(since.rows[0].n) > 0) {
      await pg.query(`UPDATE crm_followups SET status='cancelled', cancel_reason='customer_engaged', cancelled_at=now() WHERE id=$1`, [fu.id]);
      return { id: fu.id, action: 'cancel:engaged' };
    }
  }
  if (fu.kind === 'unpaid_reminder') {
    // Cancel if order already paid (caller should set context.order_id)
    const orderId = fu.context?.order_id;
    if (orderId) {
      try {
        const mysql = require('../db/mysql');
        const [rows] = await mysql.query(
          `SELECT payment_status FROM \`order\` WHERE id = ? LIMIT 1`, [orderId]
        );
        if (rows[0]?.payment_status === 'paid') {
          await pg.query(`UPDATE crm_followups SET status='cancelled', cancel_reason='paid', cancelled_at=now() WHERE id=$1`, [fu.id]);
          return { id: fu.id, action: 'cancel:paid' };
        }
      } catch {}
    }
  }

  // Send
  try {
    const sent = await waClient.sendText({ phone: conv.phone, text: fu.body_template, session: conv.wa_session });
    await pg.query(
      `INSERT INTO crm_messages (conversation_id, direction, sender_type, body, message_type, send_status, waha_message_id, ai_metadata)
       VALUES ($1, 'out', 'system', $2, 'text', 'sent', $3, $4)`,
      [fu.conversation_id, fu.body_template, sent?.id || null, JSON.stringify({ followup: true, kind: fu.kind, fu_id: fu.id })]
    );
    await pg.query(`UPDATE crm_followups SET status='sent', sent_at=now() WHERE id=$1`, [fu.id]);
    return { id: fu.id, action: 'sent' };
  } catch (err) {
    await pg.query(`UPDATE crm_followups SET status='cancelled', cancel_reason='send_failed', cancelled_at=now() WHERE id=$1`, [fu.id]);
    return { id: fu.id, action: 'cancel:send_failed', error: err.message };
  }
}

async function run() {
  const { rows } = await pg.query(
    `SELECT id, conversation_id, kind, body_template, context
     FROM crm_followups
     WHERE status = 'pending' AND scheduled_for <= now()
     ORDER BY scheduled_for LIMIT 50`
  );
  if (!rows.length) {
    logger.info('[followup] no due jobs'); await pg.end(); return;
  }
  logger.info({ count: rows.length }, '[followup] processing');
  for (const fu of rows) {
    try { logger.info(await runOne(fu), '[followup]'); }
    catch (err) { logger.error({ err: err.message, fu_id: fu.id }, '[followup] crash'); }
  }
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[followup] failed'); process.exit(1); });
}

module.exports = { run, runOne };
