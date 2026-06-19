// Vonage Messages API adapter for WhatsApp.
// - Freetext (`message_type: text`) — only valid inside the 24h customer-care window.
// - Outside window → must send a template (use sendTemplate).
// - JWT auth via VONAGE_APPLICATION_ID + VONAGE_PRIVATE_KEY_PATH.
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const API_HOST = process.env.VONAGE_API_HOST || 'api.nexmo.com';
const APP_ID   = process.env.VONAGE_APPLICATION_ID || process.env.VONAGE_APP_ID;
const KEY_PATH = process.env.VONAGE_PRIVATE_KEY_PATH || process.env.VONAGE_KEY_PATH
                 || path.join('/home/krttpt/konsumen/private.key');
const FROM     = process.env.VONAGE_WA_NUMBER || '';

let _privateKey = null;
function getPrivateKey() {
  if (!_privateKey) _privateKey = fs.readFileSync(KEY_PATH, 'utf8');
  return _privateKey;
}

function generateJWT() {
  return jwt.sign(
    { application_id: APP_ID },
    getPrivateKey(),
    { algorithm: 'RS256', expiresIn: '5m', jwtid: Math.random().toString(36).slice(2) }
  );
}

// Per-sender static JWT (some WA numbers belong to a different Vonage
// Application than the default APP_ID, so they need their own pre-signed
// long-lived JWT). Env var format: VONAGE_JWT_<sender_number>=<jwt>
function tokenFor(from) {
  if (!from) return generateJWT();
  const key = `VONAGE_JWT_${String(from).replace(/\D/g, '')}`;
  const staticJwt = process.env[key];
  if (staticJwt) return staticJwt.trim();
  return generateJWT();
}

function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).replace(/\D/g, '');
  if (s.startsWith('0')) s = '62' + s.slice(1);
  return s;
}

async function vonagePost(payload) {
  const token = tokenFor(payload.from);
  const res = await fetch(`https://${API_HOST}/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!(res.status === 202 || (res.status >= 200 && res.status < 300))) {
    const err = new Error(`Vonage ${res.status}: ${body?.title || body?.detail || text.slice(0, 200)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return { id: body.message_uuid || null, raw: body };
}

async function sendText({ phone, text, from }) {
  return vonagePost({
    channel: 'whatsapp',
    message_type: 'text',
    from: from || FROM,
    to: normalizePhone(phone),
    text,
  });
}

async function sendImage({ phone, imageUrl, caption, from }) {
  return vonagePost({
    channel: 'whatsapp',
    message_type: 'image',
    from: from || FROM,
    to: normalizePhone(phone),
    image: { url: imageUrl, caption: caption || undefined },
  });
}

async function sendFile({ phone, fileUrl, filename, caption, from }) {
  return vonagePost({
    channel: 'whatsapp',
    message_type: 'file',
    from: from || FROM,
    to: normalizePhone(phone),
    file: { url: fileUrl, caption: caption || undefined, name: filename || undefined },
  });
}

// Send approved HSM template (used to re-open 24h window).
async function sendTemplate({ phone, templateName, params = [], language = 'id', headerImageUrl, from }) {
  const textParams = params.map((p) => (typeof p === 'object' ? p.default : p) ?? '');
  const components = [];
  if (headerImageUrl) {
    components.push({ type: 'header', parameters: [{ type: 'image', image: { link: headerImageUrl } }] });
  }
  if (textParams.length > 0) {
    components.push({ type: 'body', parameters: textParams.map((t) => ({ type: 'text', text: t })) });
  }
  return vonagePost({
    channel: 'whatsapp',
    message_type: 'custom',
    from: from || FROM,
    to: normalizePhone(phone),
    custom: {
      type: 'template',
      template: {
        namespace: '',
        name: templateName,
        language: { policy: 'deterministic', code: language },
        components,
      },
    },
  });
}

// Parse Vonage inbound webhook (POST /webhook/vonage/inbound).
// Vonage WhatsApp inbound payload shape:
//   { message_uuid, to, from, channel:'whatsapp', message_type, text|image|file|...,
//     profile:{ name }, timestamp, context:{ message_uuid } }
function parseInbound(raw) {
  if (!raw || raw.channel !== 'whatsapp') {
    return { skip: 'not-whatsapp', phone: null, body: null };
  }
  const phone = normalizePhone(raw.from);
  const pushName = raw.profile?.name || null;
  const t = raw.message_type;
  let type = 'text';
  let body = null;
  let mediaUrl = null;
  let mediaMime = null;
  if (t === 'text') {
    body = raw.text || null;
  } else if (t === 'image') {
    type = 'image';
    body = raw.image?.caption || null;
    mediaUrl = raw.image?.url || null;
  } else if (t === 'video') {
    type = 'video';
    body = raw.video?.caption || null;
    mediaUrl = raw.video?.url || null;
  } else if (t === 'audio') {
    type = 'audio';
    mediaUrl = raw.audio?.url || null;
  } else if (t === 'file') {
    type = 'document';
    body = raw.file?.caption || raw.file?.name || null;
    mediaUrl = raw.file?.url || null;
  } else if (t === 'sticker') {
    type = 'sticker';
    mediaUrl = raw.sticker?.url || null;
  } else if (t === 'location') {
    type = 'location';
    body = `📍 ${raw.location?.name || ''} (${raw.location?.latitude},${raw.location?.longitude})`;
  } else if (t === 'reply') {
    body = raw.reply?.title || raw.reply?.id || null;
  } else if (t === 'reaction') {
    type = 'reaction';
    body = raw.reaction?.emoji || null;
  } else if (t === 'unsupported') {
    return { skip: 'unsupported', phone: null, body: null };
  }
  return {
    phone,
    pushName,
    body,
    wahaMessageId: raw.message_uuid || null,
    type,
    mediaUrl,
    mediaMime,
    session: 'vonage',
    skip: phone ? null : 'no-phone',
  };
}

async function getContact({ phone }) {
  return { phone: normalizePhone(phone), push_name: null, name: null, unsupported: false };
}

module.exports = {
  name: 'vonage',
  generateJWT,
  sendText, sendImage, sendFile, sendTemplate,
  parseInbound, getContact,
  // No-op pass-throughs for parity with WAHA adapter:
  startTyping: () => Promise.resolve(),
  stopTyping:  () => Promise.resolve(),
  sendSeen:    () => Promise.resolve(),
  setPresence: () => Promise.resolve(),
  getProfile:  () => Promise.resolve({ unsupported: true }),
};
