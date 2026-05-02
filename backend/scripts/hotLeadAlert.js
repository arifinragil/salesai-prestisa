// backend/scripts/hotLeadAlert.js
// Every 1 min: scan hot leads with no operator response in 3+ min and Telegram-alert.
// 5+ min escalates to supervisor (alert_kind='supervisor_5min').
// Dedup via crm_hot_lead_alerts.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const tg = require('../services/telegramNotify');
const settings = require('../services/settings');
const logger = require('../services/logger');

async function run() {
  // Find hot leads where the most recent message is inbound and >3 min old,
  // AND no out-from-staff message since that inbound.
  const q = await pg.query(
    `WITH recent AS (
       SELECT m.id AS msg_id, m.conversation_id, m.created_at AS inbound_at
       FROM crm_messages m
       JOIN crm_conversations c ON c.id = m.conversation_id
       WHERE c.lead_temperature = 'hot'
         AND c.status = 'active'
         AND m.direction = 'in'
         AND m.created_at > now() - interval '30 minutes'
         AND m.created_at < now() - interval '3 minutes'
       ORDER BY m.id DESC
       LIMIT 100
     ),
     latest_in AS (
       SELECT DISTINCT ON (conversation_id) conversation_id, msg_id, inbound_at
       FROM recent ORDER BY conversation_id, msg_id DESC
     )
     SELECT li.conversation_id, li.msg_id, li.inbound_at, c.assigned_staff_id, c.phone
     FROM latest_in li
     JOIN crm_conversations c ON c.id = li.conversation_id
     WHERE NOT EXISTS (
       SELECT 1 FROM crm_messages m2
       WHERE m2.conversation_id = li.conversation_id
         AND m2.direction = 'out'
         AND m2.sender_type IN ('operator', 'ai')
         AND m2.created_at > li.inbound_at
     )`
  );

  let owner_alerts = 0, supervisor_alerts = 0, skipped_dup = 0;
  for (const row of q.rows) {
    const ageMin = (Date.now() - new Date(row.inbound_at).getTime()) / 60_000;
    const kind = ageMin >= 5 ? 'supervisor_5min' : 'owner_3min';

    // Dedup: check if we've already alerted for this kind in the last 30 min
    const dup = await pg.query(
      `SELECT 1 FROM crm_hot_lead_alerts
       WHERE conversation_id = $1 AND alert_kind = $2 AND sent_at > now() - interval '30 minutes'
       LIMIT 1`,
      [row.conversation_id, kind]
    );
    if (dup.rows.length) { skipped_dup++; continue; }

    const text = (kind === 'supervisor_5min')
      ? `🚨 HOT LEAD UNANSWERED ${Math.round(ageMin)}m\nConv #${row.conversation_id} (${row.phone})\nEskalasi: operator owner tidak respond dalam 5 menit.`
      : `🔥 Hot lead waiting ${Math.round(ageMin)}m\nConv #${row.conversation_id} (${row.phone})\nMohon respond ASAP.`;

    let sentTo = null;
    if (kind === 'owner_3min' && row.assigned_staff_id) {
      try { await tg.sendToStaff(row.assigned_staff_id, text); sentTo = row.assigned_staff_id; owner_alerts++; }
      catch (err) { logger.warn({ err: err.message, conv: row.conversation_id }, '[hotLeadAlert] sendToStaff failed'); }
    } else {
      // No assigned owner OR escalation → default chat (supervisor)
      const supChat = await settings.getSetting('telegram_chat_sla', null) ||
                      await settings.getSetting('telegram_chat_id', null);
      if (supChat) {
        try { await tg.send(text, { _overrideChatId: supChat }); supervisor_alerts++; }
        catch (err) { logger.warn({ err: err.message }, '[hotLeadAlert] send supervisor failed'); }
      }
    }

    await pg.query(
      `INSERT INTO crm_hot_lead_alerts (conversation_id, alert_kind, inbound_msg_id, staff_id)
       VALUES ($1, $2, $3, $4)`,
      [row.conversation_id, kind, row.msg_id, sentTo]
    );
  }

  logger.info({
    candidates: q.rows.length, owner_alerts, supervisor_alerts, skipped_dup,
  }, '[hotLeadAlert] done');
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => {
    logger.error({ err: err.message }, '[hotLeadAlert] failed');
    process.exit(1);
  });
}
module.exports = { run };
