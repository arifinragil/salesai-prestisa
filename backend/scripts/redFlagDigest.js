// backend/scripts/redFlagDigest.js
// Hourly: batch high-severity red flags from last hour → 1 Telegram message
// to supervisor chat. Critical flags already pushed real-time by
// redFlagRealtime — we exclude those here.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const tg = require('../services/telegramNotify');
const settings = require('../services/settings');
const logger = require('../services/logger');

async function run() {
  const r = await pg.query(
    `SELECT f.id, f.staff_id, f.conversation_id, f.rule_id, f.detail, f.detected_at,
            u.username, u.full_name
     FROM crm_agent_red_flags f
     LEFT JOIN staff_users u ON u.id = f.staff_id
     WHERE f.severity = 'high'
       AND f.detected_at > now() - interval '1 hour'
       AND f.resolved_at IS NULL
     ORDER BY f.detected_at DESC
     LIMIT 50`
  );

  if (r.rows.length === 0) {
    logger.info({ flags: 0 }, '[redFlagDigest] no high flags');
    await pg.end();
    return;
  }

  // Group by staff for compact rendering
  const byStaff = new Map();
  for (const f of r.rows) {
    const k = f.staff_id;
    if (!byStaff.has(k)) byStaff.set(k, { name: f.full_name || f.username || `#${k}`, flags: [] });
    byStaff.get(k).flags.push(f);
  }

  const lines = [`⚠ HIGH-severity red flags (last 1h) — ${r.rows.length} total\n`];
  for (const [, group] of byStaff) {
    lines.push(`\n👤 ${group.name} (${group.flags.length})`);
    for (const f of group.flags.slice(0, 5)) {
      const conv = f.conversation_id ? ` · conv #${f.conversation_id}` : '';
      lines.push(`  • ${f.rule_id}${conv}`);
    }
    if (group.flags.length > 5) lines.push(`  … +${group.flags.length - 5} more`);
  }
  lines.push(`\n→ /supervisor untuk detail`);

  const supChat = await settings.getSetting('telegram_chat_sla', null) ||
                  await settings.getSetting('telegram_chat_id', null);
  if (!supChat) {
    logger.warn({ flags: r.rows.length }, '[redFlagDigest] no supervisor chat configured');
    await pg.end();
    return;
  }

  try {
    await tg.send(lines.join('\n'), { _overrideChatId: supChat });
    logger.info({ flags: r.rows.length, agents: byStaff.size }, '[redFlagDigest] sent');
  } catch (err) {
    logger.warn({ err: err.message }, '[redFlagDigest] send failed');
  }
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[redFlagDigest] failed'); process.exit(1); });
}
module.exports = { run };
