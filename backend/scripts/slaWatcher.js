// SLA watcher — every minute. Sends Telegram alert when handover open >SLA mins.
// Dedupes via 'sla_alerted' flag in handover.detail JSON-ish (we use a simple table-less key:
// crm_anomaly_events with kind='sla_alert' + detail=handover_id to avoid double-alerting).
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const settings = require('../services/settings');
const tg = require('../services/telegramNotify');
const logger = require('../services/logger');

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://salesai.prestisa.net';

async function effectiveSlaMinutes(convId, defaultMin) {
  // Per-tag SLA override: pick MIN(sla_minutes) across tags attached.
  const { rows } = await pg.query(
    `SELECT MIN(t.sla_minutes) AS sla
     FROM crm_conversation_tags ct
     JOIN crm_tags t ON t.id = ct.tag_id
     WHERE ct.conversation_id = $1 AND t.sla_minutes IS NOT NULL`,
    [convId]
  );
  return Number(rows[0]?.sla) || defaultMin;
}

async function run() {
  const defaultSla = parseInt(await settings.getSetting('sla_handover_minutes', 15)) || 15;
  // Pull all open handovers that *might* breach (use a generous lower bound = min(default, 1)),
  // then re-check per-tag SLA for each.
  const { rows } = await pg.query(
    `SELECT h.id, h.conversation_id, h.reason, h.detail, h.brief, h.created_at,
            c.phone, c.real_phone
     FROM crm_handovers h
     JOIN crm_conversations c ON c.id = h.conversation_id
     WHERE h.resolved_at IS NULL
       AND h.created_at < now() - interval '1 minute'
       AND NOT EXISTS (
         SELECT 1 FROM crm_anomaly_events ae
         WHERE ae.kind = 'sla_alert' AND ae.detail = h.id::text
       )
     ORDER BY h.created_at ASC LIMIT 50`
  );
  if (!rows.length) { await pg.end(); return; }

  const shift = require('../services/shiftRouter');
  for (const h of rows) {
    const slaMin = await effectiveSlaMinutes(h.conversation_id, defaultSla);
    const ageMin = Math.round((Date.now() - new Date(h.created_at).getTime()) / 60000);
    if (ageMin < slaMin) continue;
    const phone = h.real_phone || h.phone;
    const onShift = await shift.onShift();
    const opLine = onShift.length
      ? `On-shift: ${onShift.map((o) => o.full_name || o.username).join(', ')}`
      : 'On-shift: (tidak ada operator on-shift sekarang)';
    const text = `⚠️ <b>SLA breach</b> — handover open ${ageMin}m (SLA ${slaMin}m)\n` +
      `Reason: <b>${h.reason}</b>\n` +
      `Phone: <code>${phone}</code>\n` +
      (h.brief ? `Brief: ${h.brief}\n` : '') +
      (h.detail ? `Detail: ${h.detail}\n` : '') +
      opLine + `\n` +
      `\n${PUBLIC_URL}/inbox/${h.conversation_id}`;
    const r = await tg.send(text, { kind: 'sla' });
    await pg.query(
      `INSERT INTO crm_anomaly_events (kind, metric_value, threshold, window_label, detail)
       VALUES ('sla_alert', $1, $2, 'minutes', $3)`,
      [ageMin, slaMin, String(h.id)]
    );
    logger.info({ handover_id: h.id, age_min: ageMin, sla: slaMin, telegram_ok: r.ok }, '[sla] alerted');
  }
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[sla] failed'); process.exit(1); });
}

module.exports = { run };
