// backend/scripts/redFlagRealtime.js
// Every 1 min: evaluate critical/high real-time red flags.
// Critical findings → Telegram push to supervisor chat.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const det = require('../services/redFlagDetector');
const tg = require('../services/telegramNotify');
const settings = require('../services/settings');
const logger = require('../services/logger');

async function notifyCritical(flag) {
  try {
    const supChat = await settings.getSetting('telegram_chat_sla', null) ||
                    await settings.getSetting('telegram_chat_id', null);
    if (!supChat) return;
    const text = `🚨 RED FLAG (${flag.severity})\n` +
                 `Rule: ${flag.rule_id}\n` +
                 `Staff #${flag.staff_id}` +
                 (flag.conversation_id ? ` · Conv #${flag.conversation_id}` : '') + `\n` +
                 (flag.detail ? `Detail: ${JSON.stringify(flag.detail).slice(0, 200)}` : '');
    await tg.send(text, { _overrideChatId: supChat });
  } catch (err) {
    logger.warn({ err: err.message }, '[redFlagRealtime] telegram push failed');
  }
}

async function run() {
  const candidates = await det.evaluateRealtime();
  let inserted = 0, alerted = 0;
  for (const c of candidates) {
    const n = await det.record([c]);
    if (n > 0) {
      inserted++;
      if (c.severity === 'critical') {
        await notifyCritical(c);
        alerted++;
      }
    }
  }
  logger.info({ candidates: candidates.length, inserted, alerted }, '[redFlagRealtime] done');
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[redFlagRealtime] failed'); process.exit(1); });
}
module.exports = { run };
