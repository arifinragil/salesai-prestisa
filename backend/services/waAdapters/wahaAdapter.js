const BASE = process.env.WAHA_API_URL || 'http://localhost:3000';
const SESSION = process.env.WAHA_SESSION || 'tiara-pilot';
const API_KEY = process.env.WAHA_API_KEY || '';

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (API_KEY) h['X-Api-Key'] = API_KEY;
  return h;
}

function phoneToChatId(phone) {
  const s = String(phone || '').trim();
  // If already a full JID, pass through (handles @c.us, @s.whatsapp.net, @lid)
  if (s.includes('@')) return s;
  const digits = s.replace(/\D/g, '');
  // LIDs are typically 14+ digits without @ prefix; phone numbers are <=15.
  // We can't perfectly distinguish, but LID stored as bare digits is rare —
  // contactResolver-side stores normalized phone, and parseInbound preserves
  // the JID context. Default to @c.us for plain digits.
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

async function sendImage({ phone, imageUrl, caption }) {
  const body = {
    session: SESSION,
    chatId: phoneToChatId(phone),
    file: { url: imageUrl },
    caption: caption || undefined,
  };
  const res = await postWaha('/api/sendImage', body);
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

  // Resolve sender JID. WAHA NOWEB sometimes emits LID (Linked Identifier)
  // instead of a phone-number JID. LID is an opaque WhatsApp internal ID,
  // not a phone number — we try several fields to find a real phone:
  //   1. participant (group msg author)
  //   2. _data.notifyName / pushName (display name only, not a number)
  //   3. _data.author / _data.id.remote (sometimes preserves phone JID)
  //   4. fall back to from
  let jid = p.from || '';
  if (jid.endsWith('@lid')) {
    const alt = p.participant
      || (p._data && (p._data.author || (p._data.id && p._data.id.remote)))
      || (p.key && (p.key.participant || p.key.remoteJid))
      || '';
    if (alt && !String(alt).endsWith('@lid')) {
      jid = String(alt);
    }
  }

  const head = String(jid).split('@')[0];
  const isGroup = String(jid).endsWith('@g.us');
  const isBroadcast = String(jid).endsWith('@broadcast');
  const isLid = String(jid).endsWith('@lid');
  // For LID JIDs, store the full JID as `phone` so reply-routing preserves @lid.
  // For normal phone JIDs, store bare digits (existing convention).
  const phone = isLid ? jid : (head.replace(/\D/g, '') || null);

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
    session: raw.session || null,
    // LID is acceptable as conversation key — WAHA understands LID for sendText routing.
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
    session: raw.session || null,
    skip: isGroup ? 'group' : (isBroadcast ? 'broadcast' : null),
  };
}

module.exports = { name: 'waha', sendText, sendImage, parseInbound };
