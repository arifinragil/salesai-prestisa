// Telegram bot helper. Reads token + chat_id from crm_settings.
// Supports per-kind chat routing: kinds 'sla', 'anomaly', 'brief' fall back
// to telegram_chat_id (default) if not configured.
// All sends are best-effort: log + swallow on failure (never bubble up).
const settings = require('./settings');
const logger = require('./logger');

const KIND_KEY = {
  sla: 'telegram_chat_sla',
  anomaly: 'telegram_chat_anomaly',
  brief: 'telegram_chat_brief',
};

async function getToken() {
  const t = await settings.getSetting('telegram_bot_token', '');
  return (t || '').trim();
}

async function resolveChatId(kind) {
  const def = (await settings.getSetting('telegram_chat_id', '')) || '';
  if (!kind) return def.trim();
  const key = KIND_KEY[kind];
  if (!key) return def.trim();
  const specific = (await settings.getSetting(key, '')) || '';
  return (specific.trim() || def.trim());
}

async function send(text, opts = {}) {
  try {
    const token = await getToken();
    if (!token) return { ok: false, skipped: 'unconfigured' };
    const chatId = await resolveChatId(opts.kind);
    if (!chatId) return { ok: false, skipped: 'no chat for kind=' + (opts.kind || 'default') };
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),
        parse_mode: opts.parseMode || 'HTML',
        disable_web_page_preview: opts.disablePreview ?? true,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      logger.warn({ status: r.status, data, kind: opts.kind }, '[telegram] send failed');
      return { ok: false, error: data.description || `http ${r.status}` };
    }
    return { ok: true, message_id: data.result.message_id, chat_id: chatId };
  } catch (err) {
    logger.warn({ err: err.message }, '[telegram] threw');
    return { ok: false, error: err.message };
  }
}

// Verify by calling getMe — useful for settings page "Test" button.
async function getMe() {
  const { token } = await getConfig();
  if (!token) return { ok: false, error: 'no token' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await r.json();
    if (!r.ok || !data.ok) return { ok: false, error: data.description || `http ${r.status}` };
    return { ok: true, username: data.result.username, first_name: data.result.first_name };
  } catch (err) { return { ok: false, error: err.message }; }
}

module.exports = { send, getMe };
