let io = null;

function setIO(ioInstance) { io = ioInstance; }
function getIO() { return io; }

function notifyMessage({ conversation_id, message }) {
  if (!io) return;
  io.to(`crm:conv:${conversation_id}`).emit('crm:message', { conversation_id, message });
  io.to('crm:inbox').emit('crm:conv-updated', { conversation_id });
}

function notifyHandover({ conversation_id, reason, summary }) {
  const payload = { conversation_id, reason, summary, at: new Date().toISOString() };
  if (io) {
    io.to('crm:inbox').emit('crm:handover', payload);
    io.to('crm:monitor').emit('crm:handover', payload);
  }
  // External webhook (Slack/Discord/etc) — fire-and-forget
  fireExternalWebhook(payload).catch(() => {});
}

async function fireExternalWebhook({ conversation_id, reason, summary }) {
  let url;
  try {
    const settings = require('./settings');
    const cfg = await settings.getSetting('handover_webhook', null);
    if (!cfg || !cfg.url || cfg.enabled === false) return;
    url = cfg.url;
    const filter = Array.isArray(cfg.reasons) ? cfg.reasons : null;
    if (filter && !filter.includes(reason)) return;

    const baseUrl = process.env.CRM_FRONTEND_ORIGIN || 'https://salesai.prestisa.net';
    const link = `${baseUrl}/inbox/${conversation_id}`;
    const text = `⚠️ Tiara handover: *${reason}* — conv #${conversation_id}\n${summary || ''}\n${link}`;
    const body = /discord\.com\/api\/webhooks/.test(url) ? { content: text } : { text };

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    try { require('./logger').warn({ err: err.message, url }, '[notify] webhook delivery failed'); } catch {}
  }
}

function notifyConvUpdated(conversation_id) {
  if (!io) return;
  io.to('crm:inbox').emit('crm:conv-updated', { conversation_id });
}

function notifyMetrics(payload) {
  if (!io) return;
  io.to('crm:monitor').emit('crm:metrics', payload);
}

module.exports = { setIO, getIO, notifyMessage, notifyHandover, notifyConvUpdated, notifyMetrics };
