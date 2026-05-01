const BASE = process.env.WAHA_API_URL || 'http://localhost:3000';
const SESSION = process.env.WAHA_SESSION || 'tiara-pilot';
const API_KEY = process.env.WAHA_API_KEY || '';

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (API_KEY) h['X-Api-Key'] = API_KEY;
  return h;
}

function phoneToChatId(phone) {
  const digits = String(phone).replace(/\D/g, '');
  return `${digits}@c.us`;
}

async function postWaha(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const e = new Error(`WAHA ${path} ${res.status}: ${errText}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

async function sendText({ phone, text, replyTo }) {
  const body = { session: SESSION, chatId: phoneToChatId(phone), text };
  if (replyTo) body.reply_to = replyTo;
  const res = await postWaha('/api/sendText', body);
  return { id: res.id || res._data?.id?._serialized || null, raw: res };
}

// Normalize WAHA inbound webhook payload to canonical shape.
// Supports two formats:
//   1. Native WAHA webhook (NOWEB/WEBJS engines):
//      { event: "message", session: "...", payload: { id, from, body, fromMe, hasMedia, ... } }
//   2. n8n forwarder format (mitra-style):
//      { wa_jid, push_name, body, waha_message_id, attachment_type, attachment_url, ... }
function parseInbound(raw) {
  // Detect native WAHA event envelope
  if (raw && raw.event && raw.payload && typeof raw.payload === 'object') {
    return parseNative(raw);
  }
  return parseForwarder(raw || {});
}

function parseNative(raw) {
  const event = raw.event || '';
  const p = raw.payload || {};
  // Skip non-message events (status/ack/etc.) and outbound (fromMe)
  if (!event.startsWith('message')) {
    return { skip: `event:${event}`, phone: null, body: null };
  }
  if (p.fromMe) {
    return { skip: 'fromMe', phone: null, body: null };
  }

  const jid = p.from || '';
  const head = String(jid).split('@')[0];
  const phone = head.replace(/\D/g, '') || null;
  const isGroup = String(jid).endsWith('@g.us');
  const isBroadcast = String(jid).endsWith('@broadcast');

  // Body extraction — body is usually at root, sometimes nested in media
  const body = p.body
    || (typeof p.text === 'string' ? p.text : null)
    || (p.message && p.message.conversation)
    || (p.message && p.message.extendedTextMessage && p.message.extendedTextMessage.text)
    || null;

  const type = p.hasMedia
    ? (p.media && p.media.mimetype ? p.media.mimetype.split('/')[0] : 'media')
    : 'text';

  const mediaUrl = (p.media && (p.media.url || p.media.link)) || null;
  const mediaMime = (p.media && p.media.mimetype) || null;

  return {
    phone,
    pushName: p.notifyName || p._data?.notifyName || null,
    body,
    wahaMessageId: p.id || null,
    type,
    mediaUrl,
    mediaMime,
    skip: isGroup ? 'group' : (isBroadcast ? 'broadcast' : null),
  };
}

function parseForwarder(raw) {
  const jid = raw.wa_jid || raw.from || '';
  const head = String(jid).split('@')[0];
  const phone = head.replace(/\D/g, '') || null;
  const isGroup = String(jid).endsWith('@g.us');
  const isBroadcast = String(jid).endsWith('@broadcast');
  const type = raw.attachment_type ? raw.attachment_type
    : (raw.media_url ? 'media' : 'text');
  return {
    phone,
    pushName: raw.push_name || null,
    body: raw.body || null,
    wahaMessageId: raw.waha_message_id || null,
    type,
    mediaUrl: raw.attachment_url || raw.media_url || null,
    mediaMime: raw.media_mimetype || null,
    skip: isGroup ? 'group' : (isBroadcast ? 'broadcast' : null),
  };
}

module.exports = { name: 'waha', sendText, parseInbound };
