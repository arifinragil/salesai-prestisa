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

async function getWaha(path) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const e = new Error(`WAHA GET ${path} ${res.status}: ${errText.slice(0, 120)}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

// Send WhatsApp typing indicator + seen receipt — humanizes bot signature
// to reduce risk of WhatsApp's anti-bot detection.
async function startTyping({ phone, session }) {
  try {
    await postWaha('/api/startTyping', { session: session || SESSION, chatId: phoneToChatId(phone) });
  } catch (err) { /* non-fatal */ }
}
async function stopTyping({ phone, session }) {
  try {
    await postWaha('/api/stopTyping', { session: session || SESSION, chatId: phoneToChatId(phone) });
  } catch (err) { /* non-fatal */ }
}
// Set session presence on WhatsApp ('available' = online dot visible to contacts).
async function setPresence({ session, presence }) {
  try {
    await postWaha('/api/presence', {
      session: session || SESSION,
      presence: presence || 'available',
    });
  } catch (err) { /* non-fatal */ }
}

// Get session profile (name, status, pic) — for setup verification.
async function getProfile({ session }) {
  try {
    return await getWaha(`/api/${encodeURIComponent(session || SESSION)}/profile`);
  } catch (err) { return { error: err.message }; }
}

// Set profile name / status / picture URL.
async function setProfileName({ session, name }) {
  return postWaha(`/api/${encodeURIComponent(session || SESSION)}/profile/name`, { name });
}
async function setProfileStatus({ session, status }) {
  return postWaha(`/api/${encodeURIComponent(session || SESSION)}/profile/status`, { status });
}
async function setProfilePicture({ session, fileUrl, mimetype }) {
  return postWaha(`/api/${encodeURIComponent(session || SESSION)}/profile/picture`, {
    file: { url: fileUrl, mimetype: mimetype || 'image/jpeg' },
  });
}

async function sendSeen({ phone, messageId, session }) {
  try {
    await postWaha('/api/sendSeen', {
      session: session || SESSION,
      chatId: phoneToChatId(phone),
      messageId: messageId || undefined,
    });
  } catch (err) { /* non-fatal */ }
}

async function getContact({ phone, session }) {
  const sess = session || SESSION;
  const chatId = phoneToChatId(phone);
  const out = { contactId: chatId };
  // Basic contact info (name, push name, business profile flag)
  try {
    const c = await getWaha(`/api/contacts?contactId=${encodeURIComponent(chatId)}&session=${encodeURIComponent(sess)}`);
    Object.assign(out, {
      name: c.name || c.pushname || c.shortName || null,
      push_name: c.pushname || null,
      short_name: c.shortName || null,
      is_business: !!c.isBusiness,
      is_my_contact: !!c.isMyContact,
      number: c.number || null,
    });
  } catch (err) { out.contact_error = err.message; }
  // Profile picture URL (may be null if user hides it)
  try {
    const pic = await getWaha(`/api/${encodeURIComponent(sess)}/contacts/profile-picture?contactId=${encodeURIComponent(chatId)}`);
    out.profile_picture_url = pic.url || null;
  } catch (err) { out.picture_error = err.message; }
  return out;
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

async function sendFile({ phone, fileUrl, mimetype, filename, caption }) {
  const body = {
    session: SESSION,
    chatId: phoneToChatId(phone),
    file: { url: fileUrl, mimetype, filename },
    caption: caption || undefined,
  };
  const res = await postWaha('/api/sendFile', body);
  return { id: res.id || res._data?.id?._serialized || null, raw: res };
}

// WAHA buttons (NOWEB has limited support; some engines reject — caller should fallback).
// rows: [{title, description?, rowId}]; sections: [{title, rows:[]}]
async function sendButtons({ phone, header, body, footer, buttons }) {
  // buttons: [{id, text}]
  const payload = {
    session: SESSION,
    chatId: phoneToChatId(phone),
    header: header ? { type: 'text', text: header } : undefined,
    body: { text: body },
    footer: footer ? { text: footer } : undefined,
    action: {
      buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.text.slice(0, 20) } })),
    },
  };
  const res = await postWaha('/api/sendButtons', payload);
  return { id: res.id || null, raw: res };
}

async function sendList({ phone, header, body, footer, buttonText, sections }) {
  const payload = {
    session: SESSION,
    chatId: phoneToChatId(phone),
    header: header ? { type: 'text', text: header } : undefined,
    body: { text: body },
    footer: footer ? { text: footer } : undefined,
    action: {
      button: buttonText || 'Pilih',
      sections: sections.map((s) => ({
        title: s.title,
        rows: s.rows.map((r) => ({ rowId: r.rowId, title: r.title, description: r.description || undefined })),
      })),
    },
  };
  const res = await postWaha('/api/sendList', payload);
  return { id: res.id || null, raw: res };
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

  const mediaObj = p.media || null;
  const mediaUrl = (mediaObj && (mediaObj.url || mediaObj.link)) || null;
  const mediaMime = (mediaObj && mediaObj.mimetype) || null;
  // Detect media from URL OR mimetype OR hasMedia flag — any signal counts.
  const hasMedia = !!(p.hasMedia || mediaUrl || mediaMime);
  let type;
  if (hasMedia) {
    if (mediaMime) {
      const main = mediaMime.split('/')[0];
      type = main === 'application' ? 'document' : main; // image / video / audio / document
    } else {
      type = 'media';
    }
  } else {
    type = 'text';
  }

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

module.exports = {
  name: 'waha', sendText, sendImage, sendFile, sendButtons, sendList, parseInbound, getContact,
  startTyping, stopTyping, sendSeen, setPresence,
  getProfile, setProfileName, setProfileStatus, setProfilePicture,
};
