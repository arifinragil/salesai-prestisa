// /api/lotus-inbox — read & act on conversations from the Lotus PG mirror
// (lotus_conversations DB). Read sources: contacts, messages. Outbound goes
// out via Vonage (vonageAdapter). CRM-side state is stored in crm_lotus_state
// in the main vonage_reports DB.
const express = require('express');
const pg = require('../db/postgres');
const lotus = require('../db/lotus');
const mysql = require('../db/mysql');
const { requireStaff } = require('../middleware/auth');
const vonage = require('../services/waAdapters/vonageAdapter');
const { upload, publicUrlFor, attachmentTypeFor } = require('../services/uploadService');
const aiClient = require('../services/aiClient');
const persona = require('../services/aiPersona');
const tools = require('../services/aiTools');
const logger = require('../services/logger');

const router = express.Router();
router.use(requireStaff);

// ── helpers ────────────────────────────────────────────────────────────────
async function getStateMap(lotusIds) {
  if (!lotusIds.length) return new Map();
  const { rows } = await pg.query(
    `SELECT * FROM crm_lotus_state WHERE lotus_id = ANY($1::text[])`,
    [lotusIds]
  );
  return new Map(rows.map((r) => [r.lotus_id, r]));
}

async function ensureState(lotusId, custNumber) {
  await pg.query(
    `INSERT INTO crm_lotus_state (lotus_id, cust_number)
     VALUES ($1, $2)
     ON CONFLICT (lotus_id) DO UPDATE SET
       cust_number = COALESCE(crm_lotus_state.cust_number, EXCLUDED.cust_number)`,
    [lotusId, custNumber || null]
  );
}

async function getContact(lotusId) {
  const { rows } = await lotus.query(
    `SELECT lotus_id, contact_id, cust_number, cust_name, business_number,
            assign_to_user, assign_to_user_name, label, lead_product,
            last_message, last_message_from, last_message_at, last_inbound_at,
            unread_counter, city_id, city_name, delivery_date
     FROM contacts WHERE lotus_id = $1`,
    [lotusId]
  );
  return rows[0] || null;
}

// ── list contacts ─────────────────────────────────────────────────────────
router.get('/contacts', async (req, res) => {
  const q       = String(req.query.q || '').trim();
  const queue   = req.query.queue;                              // mine | unassigned | all
  const status  = req.query.status;                             // active | closed | spam
  const label   = req.query.label || null;
  const limit   = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset  = Math.max(parseInt(req.query.offset) || 0, 0);

  const params = [];
  const where = [];
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(`(LOWER(c.cust_name) LIKE $${params.length} OR c.cust_number LIKE $${params.length})`);
  }
  if (label) { params.push(label); where.push(`c.label = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // contacts.last_message_at is a lagging aggregate (lotus-tailer only refreshes
  // last_inbound_at on inbound; last_message_at can be 10h+ stale). Sort by the
  // fresher of the two columns first to page through correctly, then a lateral
  // fetch overrides preview body/timestamp with the actual latest message row.
  const { rows: contacts } = await lotus.query(
    `WITH paged AS (
       SELECT c.lotus_id, c.cust_number, c.cust_name, c.business_number,
              c.assign_to_user_name, c.label, c.last_message, c.last_message_from,
              c.last_message_at, c.last_inbound_at, c.unread_counter, c.city_name,
              c.lead_product
       FROM contacts c
       ${whereSql}
       ORDER BY GREATEST(c.last_message_at, c.last_inbound_at) DESC NULLS LAST
       LIMIT ${limit} OFFSET ${offset}
     )
     SELECT p.lotus_id, p.cust_number, p.cust_name, p.business_number,
            p.assign_to_user_name, p.label, p.unread_counter, p.city_name,
            p.lead_product, p.last_inbound_at,
            COALESCE(lm.received_at, p.last_message_at) AS last_message_at,
            COALESCE(lm.body,        p.last_message)    AS last_message,
            COALESCE(lm.direction,   p.last_message_from) AS last_message_from
     FROM paged p
     LEFT JOIN LATERAL (
       SELECT received_at, body, direction
       FROM messages m
       WHERE m.cust_number = p.cust_number
       ORDER BY received_at DESC NULLS LAST, id DESC
       LIMIT 1
     ) lm ON true
     ORDER BY COALESCE(lm.received_at, p.last_message_at) DESC NULLS LAST`,
    params
  );

  const stateMap = await getStateMap(contacts.map((c) => c.lotus_id));

  // CRM-side filter on top of fetched contacts (queue/status). Note: this is
  // post-filter so true server-side cursor with these filters would require
  // joining across DBs — skip for now, list LIMIT 200 keeps it cheap.
  const items = contacts.map((c) => {
    const s = stateMap.get(c.lotus_id) || {};
    return {
      lotus_id: c.lotus_id,
      cust_number: c.cust_number,
      cust_name: c.cust_name,
      push_name: c.cust_name,
      business_number: c.business_number,
      label: c.label,
      lead_product: c.lead_product,
      last_body: c.last_message,
      last_message_from: c.last_message_from,
      last_at: c.last_message_at,
      last_inbound_at: c.last_inbound_at,
      unread: c.unread_counter || 0,
      city_name: c.city_name,
      lotus_assign_to: c.assign_to_user_name,
      // CRM state overlay:
      assigned_staff_id: s.assigned_staff_id || null,
      status: s.status || 'active',
      shadow_mode: s.shadow_mode || false,
      snoozed_until: s.snoozed_until || null,
      ai_paused_until: s.ai_paused_until || null,
      lead_temperature: s.lead_temperature || null,
    };
  }).filter((it) => {
    if (status && it.status !== status) return false;
    if (queue === 'mine'        && it.assigned_staff_id !== req.staff.staff_id) return false;
    if (queue === 'unassigned'  && it.assigned_staff_id != null) return false;
    return true;
  });

  res.json({ success: true, items, count: items.length, limit, offset });
});

// ── contact detail / profile ───────────────────────────────────────────────
router.get('/contacts/:lotus_id', async (req, res) => {
  const id = req.params.lotus_id;
  const c = await getContact(id);
  if (!c) return res.status(404).json({ success: false, message: 'not found' });

  await ensureState(id, c.cust_number);
  const [{ rows: stateRows }, { rows: lastRows }] = await Promise.all([
    pg.query(`SELECT * FROM crm_lotus_state WHERE lotus_id = $1`, [id]),
    lotus.query(
      `SELECT MAX(received_at) AS last_inbound
       FROM messages WHERE cust_number = $1 AND direction = 'inbound'`,
      [c.cust_number]
    ),
  ]);
  const s = stateRows[0] || {};
  // Override stale aggregate with fresh value from messages
  const freshLastInbound = lastRows[0]?.last_inbound || c.last_inbound_at;

  res.json({
    success: true,
    contact: {
      lotus_id: c.lotus_id, contact_id: c.contact_id,
      cust_number: c.cust_number, cust_name: c.cust_name,
      business_number: c.business_number, label: c.label,
      lead_product: c.lead_product, city_name: c.city_name,
      last_message: c.last_message, last_message_at: c.last_message_at,
      last_inbound_at: freshLastInbound, unread_counter: c.unread_counter,
      lotus_assigned_to: c.assign_to_user_name,
    },
    state: {
      assigned_staff_id: s.assigned_staff_id || null,
      status: s.status || 'active',
      shadow_mode: s.shadow_mode || false,
      snoozed_until: s.snoozed_until || null,
      snoozed_by: s.snoozed_by || null,
      snoozed_note: s.snoozed_note || null,
      ai_paused_until: s.ai_paused_until || null,
      lead_temperature: s.lead_temperature || null,
      lead_score: s.lead_score || null,
      last_intent: s.last_intent || null,
      ai_summary: s.ai_summary || null,
      ai_summary_msg_count: s.ai_summary_msg_count || null,
      ai_summary_generated_at: s.ai_summary_generated_at || null,
    },
  });
});

// ── media proxy ────────────────────────────────────────────────────────────
// Vonage Messages API media URLs (api.nexmo.com/v3/media/<uuid>) require a
// fresh JWT. We fetch with auth and stream back so the browser <img> tag can
// load it. Only allows hosts on the Vonage media domain.
router.get('/media', async (req, res) => {
  const msgId = parseInt(req.query.msg_id);
  let url = req.query.url;
  if (msgId) {
    const { rows } = await lotus.query(
      `SELECT raw_doc, message_type FROM messages WHERE id = $1`,
      [msgId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'msg not found' });
    url = rows[0].raw_doc?.message?.message?.url || null;
  }
  if (!url || !/^https:\/\/api(-\w+)?\.(nexmo|vonage)\.com\/v\d+\/media\//i.test(url)) {
    return res.status(400).json({ success: false, message: 'invalid or unsupported media url' });
  }
  try {
    const token = vonage.generateJWT();
    const upstream = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '');
      logger.warn({ status: upstream.status, body: body.slice(0, 300) }, '[lotus.media] upstream failed');
      return res.status(upstream.status).end();
    }
    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'private, max-age=86400'); // 1 day
    const cd = upstream.headers.get('content-disposition');
    if (cd) res.setHeader('Content-Disposition', cd);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    logger.error({ err: e.message }, '[lotus.media] proxy error');
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── messages ───────────────────────────────────────────────────────────────
router.get('/contacts/:lotus_id/messages', async (req, res) => {
  const id    = req.params.lotus_id;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const before= req.query.before; // optional ISO timestamp for paging older

  // messages → contact link is via cust_number (messages.lotus_id is the
  // per-message id, not the contact id).
  const contact = await getContact(id);
  if (!contact) return res.status(404).json({ success: false, message: 'not found' });

  const params = [contact.cust_number];
  let cursor = '';
  if (before) { params.push(before); cursor = `AND received_at < $${params.length}`; }

  // Match by cust_number (inbound + correctly-tailed outbound) OR, for outbound
  // rows where the historical lotus-tailer stored cust_number = business number,
  // by the recipient phone in raw_doc.message.to. Without the second clause those
  // outbound messages are invisible in the thread (only inbound shows).
  const { rows } = await lotus.query(
    `SELECT id, lotus_id, message_id, direction, body, message_type, channel,
            cs_id, cs_name, hsm_name, received_at, created_at, raw_doc
     FROM messages
     WHERE (cust_number = $1 OR (direction = 'outbound' AND raw_doc->'message'->>'to' = $1)) ${cursor}
     ORDER BY received_at DESC NULLS LAST, id DESC
     LIMIT ${limit + 1}`,
    params
  );
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const messages = pageRows.reverse().map((m) => {
    const mt = (m.message_type || 'text').toLowerCase();
    // raw_doc.message.message has { url, type, caption, fileName, mediaId } for
    // image/document/video. For LOCATION: { latitude, longitude }.
    const payload = m.raw_doc?.message?.message || m.raw_doc?.message || {};
    const url = payload.url || null;
    // Vonage Messages API media URLs require JWT auth — proxy through us.
    // S3/CDN URLs are public, pass through.
    const isVonageMedia = url && /api(-\w+)?\.(nexmo|vonage)\.com\/v\d+\/media\//i.test(url);
    const isMediaType = ['image', 'video', 'document', 'audio'].includes(mt);
    const media = (mt === 'text' || (!url && !isMediaType)) ? null : url ? {
      url: isVonageMedia
        ? `/api/lotus-inbox/media?msg_id=${m.id}`
        : url,
      original_url: url,
      type: mt,
      caption: payload.caption || '',
      file_name: payload.fileName || null,
      requires_proxy: isVonageMedia,
    } : {
      // URL hilang (umum untuk outbound legacy dari Lavender — raw_doc cuma
      // simpan type/caption/fileName). Tetap kirim metadata supaya FE bisa
      // tampilkan placeholder "image tidak tersedia" alih-alih bubble kosong.
      url: null,
      original_url: null,
      type: mt,
      caption: payload.caption || '',
      file_name: payload.fileName || null,
      requires_proxy: false,
      unavailable: true,
    };
    const location = mt === 'location' ? {
      latitude:  payload.latitude  ?? m.raw_doc?.message?.latitude  ?? null,
      longitude: payload.longitude ?? m.raw_doc?.message?.longitude ?? null,
      name:      payload.name      || m.raw_doc?.message?.name      || null,
      address:   payload.address   || m.raw_doc?.message?.address   || null,
    } : null;
    return {
      id: m.id,
      message_id: m.message_id,
      direction: m.direction === 'outbound' ? 'out' : 'in',
      sender_type: m.direction === 'outbound' ? (m.cs_id ? 'staff' : 'system') : 'customer',
      staff_name: m.cs_name || null,
      body: m.body || payload.caption || '',
      message_type: mt,
      hsm_name: m.hsm_name || null,
      channel: m.channel || null,
      media,
      location,
      created_at: m.received_at || m.created_at,
    };
  });
  // Next-page cursor = oldest message's created_at (for "load older")
  const next_before = messages[0]?.created_at || null;
  res.json({ success: true, messages, has_more: hasMore, next_before });
});

// ── send freetext via Vonage ───────────────────────────────────────────────
// 24-hour window enforced via contacts.last_inbound_at — if expired, refuse.
router.post('/contacts/:lotus_id/send', async (req, res) => {
  const id   = req.params.lotus_id;
  const body = (req.body?.body || '').toString().trim();
  if (!body) return res.status(400).json({ success: false, message: 'body required' });

  const c = await getContact(id);
  if (!c) return res.status(404).json({ success: false, message: 'contact not found' });
  if (!c.cust_number) return res.status(400).json({ success: false, message: 'cust_number missing' });

  // contacts.last_inbound_at is a lagging aggregate — check messages table
  // directly for the freshest inbound timestamp.
  const { rows: lastRows } = await lotus.query(
    `SELECT MAX(received_at) AS last_inbound
     FROM messages WHERE cust_number = $1 AND direction = 'inbound'`,
    [c.cust_number]
  );
  const last = lastRows[0]?.last_inbound ? new Date(lastRows[0].last_inbound).getTime() : 0;
  const ageHours = (Date.now() - last) / 3600_000;
  if (!last || ageHours > 24) {
    return res.status(409).json({
      success: false, code: 'window_closed',
      message: `24h customer-care window closed (last_inbound ${last ? Math.round(ageHours) + 'h' : 'never'} ago). Kirim HSM template dulu.`,
    });
  }

  // Pick sender: prefer contact.business_number IF it's in our allowlist,
  // otherwise fall back to VONAGE_WA_NUMBER (the verified default sender).
  const allowedSenders = (process.env.VONAGE_SENDERS || process.env.VONAGE_WA_NUMBER || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const senderFrom = allowedSenders.includes(c.business_number)
    ? c.business_number
    : (process.env.VONAGE_WA_NUMBER || undefined);
  if (!allowedSenders.includes(c.business_number)) {
    logger.warn({ lotusId: id, contact_from: c.business_number, fallback_from: senderFrom },
      '[lotusInbox.send] business_number not in VONAGE_SENDERS, falling back');
  }

  let sent;
  try {
    sent = await vonage.sendText({
      phone: c.cust_number,
      from: senderFrom,
      text: body,
    });
  } catch (err) {
    logger.error({ err: err.message, lotusId: id, status: err.status, vonage: err.body }, '[lotusInbox.send] vonage failed');
    return res.status(502).json({ success: false, message: `Vonage send failed: ${err.message}`, vonage: err.body || null });
  }

  // Insert as outbound row in lotus.messages (lotus_id is per-message UNIQUE;
  // we use Vonage message_uuid, fallback to crm-prefixed timestamp).
  const msgLotusId = sent.id ? `vonage:${sent.id}` : `crm:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  try {
    await lotus.query(
      `INSERT INTO messages
         (lotus_id, message_id, direction, cust_number, cust_name, business_number,
          channel, message_type, body, received_at, created_at, cs_id, cs_name, raw_doc, ingested_at)
       VALUES ($1, $2, 'outbound', $3, $4, $5, 'whatsapp', 'text', $6, now(), now(),
               $7, $8, $9::jsonb, now())
       ON CONFLICT (lotus_id) DO NOTHING`,
      [
        msgLotusId, sent.id || null, c.cust_number, c.cust_name, c.business_number,
        body, req.staff.staff_id, req.staff.full_name || req.staff.username || null,
        JSON.stringify({ source: 'salesai_crm', vonage: sent.raw || null }),
      ]
    );
  } catch (err) {
    logger.warn({ err: err.message }, '[lotusInbox.send] lotus insert failed (non-fatal)');
  }

  // Bump first_response_at in crm_lotus_state
  await ensureState(id, c.cust_number);
  await pg.query(
    `UPDATE crm_lotus_state SET first_response_at = COALESCE(first_response_at, now()),
       updated_at = now() WHERE lotus_id = $1`,
    [id]
  );

  const io = req.app.get('io');
  if (io) {
    const msgPayload = {
      lotus_id: id,
      message: {
        id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        direction: 'out', sender_type: 'staff',
        staff_name: req.staff.full_name || req.staff.username || null,
        body, message_type: 'text',
        created_at: new Date().toISOString(),
      },
    };
    io.to(`crm:lotus:${id}`).emit('crm:lotus-message', msgPayload);
    io.to('crm:lotus-inbox').emit('crm:lotus-conv-updated', { lotus_id: id });
  }

  res.json({
    success: true,
    message_uuid: sent.id || null,
    sender_used: senderFrom,
    sender_was_substituted: senderFrom !== c.business_number,
  });
});

// ── send image/document via Vonage ─────────────────────────────────────────
// Multipart upload: field `file`, optional `caption`. File stored under
// /uploads, public URL passed to Vonage (Vonage downloads it server-side and
// forwards via WhatsApp). Same 24h window guard as text /send.
router.post('/contacts/:lotus_id/send-file', upload.single('file'), async (req, res) => {
  const id = req.params.lotus_id;
  if (!req.file) return res.status(400).json({ success: false, message: 'file required (multipart field "file")' });

  const c = await getContact(id);
  if (!c) return res.status(404).json({ success: false, message: 'contact not found' });
  if (!c.cust_number) return res.status(400).json({ success: false, message: 'cust_number missing' });

  // 24h window guard (fresh from messages, not stale contacts.last_inbound_at)
  const { rows: lastRows } = await lotus.query(
    `SELECT MAX(received_at) AS last_inbound FROM messages
     WHERE cust_number = $1 AND direction = 'inbound'`,
    [c.cust_number]
  );
  const last = lastRows[0]?.last_inbound ? new Date(lastRows[0].last_inbound).getTime() : 0;
  const ageHours = (Date.now() - last) / 3600_000;
  if (!last || ageHours > 24) {
    return res.status(409).json({
      success: false, code: 'window_closed',
      message: `24h window tutup (${last ? Math.round(ageHours) + 'h' : 'never'}). Media tidak bisa dikirim outside window — pakai HSM dengan header image.`,
    });
  }

  const url = publicUrlFor(req.file.filename);
  const attachType = attachmentTypeFor(req.file.mimetype); // image | video | audio | document
  const caption = (req.body?.caption || '').toString().trim() || null;

  // Sender allowlist (same as /send)
  const allowedSenders = (process.env.VONAGE_SENDERS || process.env.VONAGE_WA_NUMBER || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const senderFrom = allowedSenders.includes(c.business_number)
    ? c.business_number
    : (process.env.VONAGE_WA_NUMBER || undefined);

  let sent;
  try {
    if (attachType === 'image') {
      sent = await vonage.sendImage({
        phone: c.cust_number,
        from: senderFrom,
        imageUrl: url,
        caption,
      });
    } else {
      // document / video / audio — Vonage Messages API supports image/file/audio/video.
      sent = await vonage.sendFile({
        phone: c.cust_number,
        from: senderFrom,
        fileUrl: url,
        filename: req.file.originalname,
        caption,
      });
    }
  } catch (err) {
    logger.error({ err: err.message, lotusId: id, status: err.status, vonage: err.body }, '[lotusInbox.send-file] vonage failed');
    return res.status(502).json({ success: false, message: `Vonage send failed: ${err.message}`, vonage: err.body || null });
  }

  // Mirror in lotus.messages so it appears in the chat thread
  const msgLotusId = sent.id ? `vonage:${sent.id}` : `crm:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const msgType = attachType.toUpperCase(); // IMAGE | DOCUMENT | VIDEO | AUDIO
  try {
    await lotus.query(
      `INSERT INTO messages
         (lotus_id, message_id, direction, cust_number, cust_name, business_number,
          channel, message_type, body, received_at, created_at, cs_id, cs_name, raw_doc, ingested_at)
       VALUES ($1, $2, 'outbound', $3, $4, $5, 'whatsapp', $6, $7, now(), now(),
               $8, $9, $10::jsonb, now())
       ON CONFLICT (lotus_id) DO NOTHING`,
      [
        msgLotusId, sent.id || null, c.cust_number, c.cust_name, c.business_number,
        msgType, caption || '',
        req.staff.staff_id, req.staff.full_name || req.staff.username || null,
        JSON.stringify({
          source: 'salesai_crm',
          message: {
            message: {
              url,
              type: msgType,
              caption: caption || '',
              fileName: req.file.originalname,
              mimeType: req.file.mimetype,
              size: req.file.size,
            },
          },
          vonage: sent.raw || null,
        }),
      ]
    );
  } catch (err) {
    logger.warn({ err: err.message }, '[lotusInbox.send-file] lotus insert failed (non-fatal)');
  }

  await ensureState(id, c.cust_number);
  await pg.query(
    `UPDATE crm_lotus_state SET first_response_at = COALESCE(first_response_at, now()),
       updated_at = now() WHERE lotus_id = $1`,
    [id]
  );

  const io = req.app.get('io');
  if (io) {
    const msgPayload = {
      lotus_id: id,
      message: {
        id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        direction: 'out', sender_type: 'staff',
        staff_name: req.staff.full_name || req.staff.username || null,
        body: caption || '',
        message_type: attachType,
        media: {
          url, type: attachType, caption: caption || '',
          file_name: req.file.originalname, requires_proxy: false,
        },
        created_at: new Date().toISOString(),
      },
    };
    io.to(`crm:lotus:${id}`).emit('crm:lotus-message', msgPayload);
    io.to('crm:lotus-inbox').emit('crm:lotus-conv-updated', { lotus_id: id });
  }

  res.json({
    success: true,
    message_uuid: sent.id || null,
    attachment_url: url,
    type: attachType,
    size: req.file.size,
    mimetype: req.file.mimetype,
    sender_used: senderFrom,
    sender_was_substituted: senderFrom !== c.business_number,
  });
});

// ── state actions ──────────────────────────────────────────────────────────
async function upsertState(lotusId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const vals = keys.map((k) => fields[k]);
  await pg.query(
    `INSERT INTO crm_lotus_state (lotus_id, ${keys.join(', ')})
     VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')})
     ON CONFLICT (lotus_id) DO UPDATE SET ${sets}, updated_at = now()`,
    [lotusId, ...vals]
  );
}

router.post('/contacts/:lotus_id/assign', async (req, res) => {
  const id = req.params.lotus_id;
  const target = req.body?.staff_id;
  let assignedTo;
  if (target === 'me' || target === undefined) assignedTo = req.staff.staff_id;
  else if (target === null) assignedTo = null;
  else assignedTo = parseInt(target) || null;
  await upsertState(id, { assigned_staff_id: assignedTo });
  res.json({ success: true, assigned_staff_id: assignedTo });
});

router.post('/contacts/:lotus_id/takeover', async (req, res) => {
  const id = req.params.lotus_id;
  await upsertState(id, {
    ai_paused_until: new Date(Date.now() + 24 * 3600 * 1000),
    assigned_staff_id: req.staff.staff_id,
  });
  res.json({ success: true });
});

router.post('/contacts/:lotus_id/resume-ai', async (req, res) => {
  await upsertState(req.params.lotus_id, { ai_paused_until: null });
  res.json({ success: true });
});

router.post('/contacts/:lotus_id/shadow', async (req, res) => {
  await upsertState(req.params.lotus_id, { shadow_mode: !!req.body?.enabled });
  res.json({ success: true, shadow_mode: !!req.body?.enabled });
});

router.post('/contacts/:lotus_id/close', async (req, res) => {
  await upsertState(req.params.lotus_id, { status: 'closed' });
  res.json({ success: true });
});

router.post('/contacts/:lotus_id/reopen', async (req, res) => {
  await upsertState(req.params.lotus_id, { status: 'active' });
  res.json({ success: true });
});

router.post('/contacts/:lotus_id/snooze', async (req, res) => {
  const hours = parseInt(req.body?.hours);
  const note  = (req.body?.note || '').toString().slice(0, 500) || null;
  if (!hours || hours < 1 || hours > 720) {
    return res.status(400).json({ success: false, message: 'hours 1-720 required' });
  }
  await upsertState(req.params.lotus_id, {
    snoozed_until: new Date(Date.now() + hours * 3600 * 1000),
    snoozed_by: req.staff.staff_id,
    snoozed_note: note,
  });
  res.json({ success: true });
});

router.post('/contacts/:lotus_id/unsnooze', async (req, res) => {
  await upsertState(req.params.lotus_id, {
    snoozed_until: null, snoozed_by: null, snoozed_note: null,
  });
  res.json({ success: true });
});

// ── AI helpers ─────────────────────────────────────────────────────────────
async function loadLotusContext(lotusId, historyLimit = 30) {
  const c = await getContact(lotusId);
  if (!c) return null;
  const { rows } = await lotus.query(
    `SELECT direction, body, message_type, received_at, cs_name
     FROM messages
     WHERE (cust_number = $1 OR (direction = 'outbound' AND raw_doc->'message'->>'to' = $1))
     ORDER BY received_at DESC NULLS LAST, id DESC LIMIT $2`,
    [c.cust_number, historyLimit]
  );
  const messages = rows.reverse().map((m) => ({
    direction: m.direction === 'outbound' ? 'out' : 'in',
    sender_type: m.direction === 'outbound' ? (m.cs_name ? 'staff' : 'system') : 'customer',
    body: m.body || '',
    message_type: m.message_type || 'text',
    created_at: m.received_at,
  }));
  return { contact: c, messages };
}

router.post('/contacts/:lotus_id/ai-suggest-reply', async (req, res) => {
  const id = req.params.lotus_id;
  const ctx = await loadLotusContext(id);
  if (!ctx) return res.status(404).json({ success: false, message: 'not found' });
  if (!ctx.messages.length) return res.status(400).json({ success: false, message: 'belum ada pesan' });

  // Adapt to persona.buildSystemPrompt's expected `conv` shape
  const fakeConv = {
    id: 0, phone: ctx.contact.cust_number, push_name: ctx.contact.cust_name,
    customer_id: null, wa_session: 'lotus', shadow_mode: false,
  };
  const baseSystem = await persona.buildSystemPrompt({
    conv: fakeConv, customerName: ctx.contact.cust_name, cityHint: ctx.contact.city_name || null,
  });
  const systemPrompt = `${baseSystem}

=== MODE: OPERATOR ASSIST (LOTUS) ===
Saat ini operator manusia handle chat ini di /lotus-inbox. Tugasmu:
- Saran 1 balasan SINGKAT (1-3 kalimat).
- JANGAN pakai tool request_handover.
- Output HANYA teks balasan, tanpa preamble.`;

  const messages = persona.buildHistoryMessages(ctx.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: '(Operator minta saran balasan untuk pesan terakhir customer)' });
  }

  const exec = (name, args) => {
    if (name === 'request_handover') return Promise.resolve({ ok: false, error: 'blocked' });
    const fn = tools.executors[name];
    if (!fn) return Promise.resolve({ error: `unknown tool ${name}` });
    return Promise.resolve(fn({ args, conv: fakeConv, customer_id: null, phone: ctx.contact.cust_number }));
  };

  try {
    const llm = await aiClient.generateWithTools({
      systemPrompt, messages, tools: tools.declarations, executor: exec, maxIterations: 4,
    });
    res.json({
      success: true, reply: (llm.text || '').trim(),
      tools_used: llm.calls.map((c) => ({ name: c.name, args: c.args, error: c.error || null })),
      usage: llm.usage,
    });
  } catch (err) {
    logger.error({ err: err.message, lotusId: id }, '[lotus.ai-suggest-reply] failed');
    res.status(502).json({ success: false, message: err.message });
  }
});

router.post('/contacts/:lotus_id/ai-summary', async (req, res) => {
  const id = req.params.lotus_id;
  const ctx = await loadLotusContext(id, 60);
  if (!ctx) return res.status(404).json({ success: false, message: 'not found' });
  if (!ctx.messages.length) return res.status(400).json({ success: false, message: 'belum ada pesan' });

  const transcript = ctx.messages.map((m) => {
    const who = m.sender_type === 'customer' ? 'Customer'
      : m.sender_type === 'staff' ? 'Operator' : 'Tiara';
    return `${who}: ${(m.body || `[${m.message_type}]`).slice(0, 300)}`;
  }).join('\n');

  const systemPrompt = `Kamu asisten yang bantu operator CS Prestisa cepat catch-up percakapan WhatsApp (data dari Lotus).`;
  const userMsg = `Ringkas percakapan berikut dalam Bahasa Indonesia. Format:

**Ringkasan:** 2-3 kalimat tentang situasinya.
**Kebutuhan customer:** apa yang dia minta / butuhkan.
**Status:** sudah diselesaikan / butuh tindakan operator / menunggu customer.
**Action item:** kalau ada, list 1-3 hal yang perlu operator lakukan selanjutnya.

Transkrip (${ctx.messages.length} pesan):
${transcript}`;

  try {
    const llm = await aiClient.generateWithTools({
      systemPrompt, messages: [{ role: 'user', content: userMsg }],
      tools: [], executor: () => ({}), maxIterations: 1,
    });
    const summary = (llm.text || '').trim();
    await ensureState(id, ctx.contact.cust_number);
    await pg.query(
      `UPDATE crm_lotus_state
         SET ai_summary = $2, ai_summary_msg_count = $3, ai_summary_generated_at = now(),
             updated_at = now()
       WHERE lotus_id = $1`,
      [id, summary, ctx.messages.length]
    );
    res.json({
      success: true, summary, message_count: ctx.messages.length,
      generated_at: new Date().toISOString(), usage: llm.usage,
    });
  } catch (err) {
    logger.error({ err: err.message, lotusId: id }, '[lotus.ai-summary] failed');
    res.status(502).json({ success: false, message: err.message });
  }
});

// ── HSM templates (re-uses konsumen's `wa_template_content` table) ─────────
router.get('/templates', async (_req, res) => {
  const { rows } = await pg.query(
    `SELECT template_name, content, var_count, header_image, updated_at
     FROM wa_template_content
     ORDER BY template_name ASC`
  );
  res.json({ success: true, items: rows });
});

// Send HSM template via Vonage. Works even outside the 24h window.
router.post('/contacts/:lotus_id/send-template', async (req, res) => {
  const id = req.params.lotus_id;
  const templateName = (req.body?.template_name || '').toString().trim();
  const params = Array.isArray(req.body?.params) ? req.body.params.map(String) : [];
  const language = (req.body?.language || 'id').toString();
  if (!templateName) return res.status(400).json({ success: false, message: 'template_name required' });

  const c = await getContact(id);
  if (!c) return res.status(404).json({ success: false, message: 'contact not found' });
  if (!c.cust_number) return res.status(400).json({ success: false, message: 'cust_number missing' });

  // Look up template metadata
  const { rows: trows } = await pg.query(
    `SELECT template_name, content, var_count, header_image
     FROM wa_template_content WHERE template_name = $1`,
    [templateName]
  );
  const tpl = trows[0];
  if (!tpl) return res.status(404).json({ success: false, message: `template ${templateName} not found` });
  if (params.length !== tpl.var_count) {
    return res.status(400).json({
      success: false, code: 'param_mismatch',
      message: `Template butuh ${tpl.var_count} parameter, dapat ${params.length}.`,
    });
  }

  // Pick sender (same allowlist logic as freetext)
  const allowedSenders = (process.env.VONAGE_SENDERS || process.env.VONAGE_WA_NUMBER || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const senderFrom = allowedSenders.includes(c.business_number)
    ? c.business_number
    : (process.env.VONAGE_WA_NUMBER || undefined);

  let sent;
  try {
    sent = await vonage.sendTemplate({
      phone: c.cust_number,
      from: senderFrom,
      templateName,
      params,
      language,
      headerImageUrl: tpl.header_image || undefined,
    });
  } catch (err) {
    logger.error({ err: err.message, lotusId: id, template: templateName,
      status: err.status, vonage: err.body }, '[lotusInbox.send-template] vonage failed');
    return res.status(502).json({ success: false, message: `Vonage send failed: ${err.message}`, vonage: err.body || null });
  }

  // Render the body text by substituting params, for mirror + UI
  let rendered = tpl.content || '';
  params.forEach((p, i) => {
    rendered = rendered.replace(new RegExp('\\{\\{' + (i + 1) + '\\}\\}', 'g'), p);
  });

  // Mirror to lotus.messages
  const msgLotusId = sent.id ? `vonage:${sent.id}` : `crm:tpl:${Date.now()}:${Math.random().toString(36).slice(2,8)}`;
  try {
    await lotus.query(
      `INSERT INTO messages
         (lotus_id, message_id, direction, cust_number, cust_name, business_number,
          channel, message_type, body, hsm_name, received_at, created_at, cs_id, cs_name, raw_doc, ingested_at)
       VALUES ($1, $2, 'outbound', $3, $4, $5, 'whatsapp', 'template', $6, $7, now(), now(),
               $8, $9, $10::jsonb, now())
       ON CONFLICT (lotus_id) DO NOTHING`,
      [
        msgLotusId, sent.id || null, c.cust_number, c.cust_name, c.business_number,
        rendered, templateName, req.staff.staff_id,
        req.staff.full_name || req.staff.username || null,
        JSON.stringify({ source: 'salesai_crm', template: templateName, params, vonage: sent.raw || null }),
      ]
    );
  } catch (err) {
    logger.warn({ err: err.message }, '[lotusInbox.send-template] lotus insert failed');
  }

  // Bump first_response_at
  await ensureState(id, c.cust_number);
  await pg.query(
    `UPDATE crm_lotus_state SET first_response_at = COALESCE(first_response_at, now()), updated_at = now() WHERE lotus_id = $1`,
    [id]
  );

  // Realtime emit
  const io = req.app.get('io');
  if (io) {
    io.to(`crm:lotus:${id}`).emit('crm:lotus-message', {
      lotus_id: id,
      message: {
        id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        direction: 'out', sender_type: 'staff',
        staff_name: req.staff.full_name || req.staff.username || null,
        body: rendered, message_type: 'template',
        hsm_name: templateName,
        created_at: new Date().toISOString(),
      },
    });
    io.to('crm:lotus-inbox').emit('crm:lotus-conv-updated', { lotus_id: id });
  }

  res.json({
    success: true, message_uuid: sent.id || null,
    template_name: templateName, rendered,
    sender_used: senderFrom,
    sender_was_substituted: senderFrom !== c.business_number,
  });
});

// ─── Customer info from MySQL POS (linked by phone) ─────────────────────────
// Returns customer record + owner sales name + active orders + last 3 complete.
// Phone matching tries several normalizations because MySQL `customer.phone`
// has inconsistent formats (62…, 0…, +62…, with/without separators).
router.get('/contacts/:lotus_id/customer-info', async (req, res) => {
  const lotusId = req.params.lotus_id;
  const c = await getContact(lotusId);
  if (!c) return res.status(404).json({ success: false, message: 'not found' });

  const raw = (c.cust_number || '').replace(/\D/g, '');
  if (!raw) return res.json({ success: true, customer: null, active: [], completed: [] });

  // Variants: 62…, 0…, +62…
  let normalized = raw;
  if (normalized.startsWith('0')) normalized = '62' + normalized.slice(1);
  const variants = [
    normalized,            // 62818555543
    '0' + normalized.slice(2),  // 0818555543
    '+' + normalized,      // +62818555543
    normalized.slice(2),   // 818555543
  ];

  try {
    const [custRows] = await mysql.query(
      `SELECT c.id, c.name, c.email, c.phone, c.address, c.cust_status,
              c.is_member, c.member_since, c.created_at, c.label,
              c.owner          AS owner_id,
              u.name           AS owner_name,
              u.email          AS owner_email,
              u.dept           AS owner_dept
       FROM customer c
       LEFT JOIN users u ON u.id = c.owner
       WHERE c.deleted_at IS NULL
         AND c.phone IN (?)
       ORDER BY c.id DESC
       LIMIT 1`,
      [variants]
    );
    const customer = custRows[0] || null;
    if (!customer) {
      return res.json({ success: true, customer: null, active: [], completed: [] });
    }

    // Active orders: approved, not yet finished
    const [activeRows] = await mysql.query(
      `SELECT o.id, o.order_number, o.status, o.payment_status, o.total,
              o.all_po_finish, o.min_delivery_date, o.max_delivery_date,
              o.created_at, o.approved_at,
              o.owner AS order_owner_id,
              ou.name AS order_owner_name,
              (SELECT GROUP_CONCAT(oi.name SEPARATOR ', ')
               FROM order_items oi WHERE oi.order_id = o.id AND oi.deleted_at IS NULL) AS items_summary
       FROM \`order\` o
       LEFT JOIN users ou ON ou.id = o.owner
       WHERE o.customer_id = ?
         AND o.deleted_at IS NULL
         AND o.status = 'approved'
         AND (o.all_po_finish = 0 OR o.all_po_finish IS NULL)
       ORDER BY o.created_at DESC
       LIMIT 5`,
      [customer.id]
    );

    // Last 3 completed orders
    const [completedRows] = await mysql.query(
      `SELECT o.id, o.order_number, o.status, o.payment_status, o.total,
              o.all_po_finish, o.min_delivery_date, o.max_delivery_date,
              o.created_at, o.approved_at,
              o.owner AS order_owner_id,
              ou.name AS order_owner_name,
              (SELECT GROUP_CONCAT(oi.name SEPARATOR ', ')
               FROM order_items oi WHERE oi.order_id = o.id AND oi.deleted_at IS NULL) AS items_summary
       FROM \`order\` o
       LEFT JOIN users ou ON ou.id = o.owner
       WHERE o.customer_id = ?
         AND o.deleted_at IS NULL
         AND o.status = 'approved'
         AND o.all_po_finish = 1
       ORDER BY o.created_at DESC
       LIMIT 3`,
      [customer.id]
    );

    // Aggregate stats
    const [statsRows] = await mysql.query(
      `SELECT
         COUNT(*) AS total_orders,
         SUM(CASE WHEN status='approved' THEN total ELSE 0 END) AS lifetime_value,
         MIN(created_at) AS first_order_at,
         MAX(created_at) AS last_order_at
       FROM \`order\` WHERE customer_id = ? AND deleted_at IS NULL`,
      [customer.id]
    );

    res.json({
      success: true,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        address: customer.address,
        status: customer.cust_status,
        label: customer.label,
        is_member: !!customer.is_member,
        member_since: customer.member_since,
        created_at: customer.created_at,
        owner: customer.owner_id ? {
          id: customer.owner_id,
          name: customer.owner_name,
          email: customer.owner_email,
          dept: customer.owner_dept,
        } : null,
      },
      stats: statsRows[0] || null,
      active: activeRows || [],
      completed: completedRows || [],
    });
  } catch (e) {
    logger.error({ err: e.message, lotusId, phone: raw }, '[lotus.customer-info] mysql error');
    res.status(500).json({ success: false, message: 'MySQL lookup failed: ' + e.message });
  }
});

// ─── Order detail w/ purchase_order images (foto hasil + lokasi + receipt) ──
// Returns the parent order summary + list of purchase_orders (one per item),
// each with absolute URLs for real_image, delivery_location, delivery_receipt.
router.get('/orders/:order_id/details', async (req, res) => {
  const orderId = parseInt(req.params.order_id);
  if (!orderId) return res.status(400).json({ success: false, message: 'invalid order_id' });

  const base = (process.env.PRODUCT_IMAGE_BASE || 'https://lavender.prestisa.id').replace(/\/+$/, '');
  const toUrl = (p) => {
    if (!p) return null;
    const s = String(p).trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    return base + (s.startsWith('/') ? s : '/' + s);
  };

  try {
    const [orderRows] = await mysql.query(
      `SELECT o.id, o.order_number, o.status, o.payment_status, o.total,
              o.all_po_finish, o.min_delivery_date, o.max_delivery_date,
              o.created_at, o.approved_at,
              o.owner AS order_owner_id, ou.name AS order_owner_name
       FROM \`order\` o
       LEFT JOIN users ou ON ou.id = o.owner
       WHERE o.id = ? AND o.deleted_at IS NULL`,
      [orderId]
    );
    const order = orderRows[0];
    if (!order) return res.status(404).json({ success: false, message: 'order not found' });

    const [poRows] = await mysql.query(
      `SELECT po.id, po.product_name, po.product_code, po.qty, po.real_price, po.total,
              po.status, po.payment_status,
              po.sender_name, po.sender_phone,
              po.receiver_name, po.receiver_phone,
              po.shipping_address, po.greetings, po.notes,
              po.date_time, po.shipped_date,
              po.tracking_number, po.shipping_expedition,
              po.image, po.real_image, po.delivery_location, po.delivery_receipt,
              po.flower_rating, po.shipping_rating, po.complaint_notes,
              po.supplier_id, sup.name AS supplier_name,
              po.owner AS po_owner_id, pou.name AS po_owner_name
       FROM purchase_order po
       LEFT JOIN supplier sup ON sup.id = po.supplier_id
       LEFT JOIN users pou ON pou.id = po.owner
       WHERE po.order_id = ? AND po.deleted_at IS NULL
       ORDER BY po.id ASC`,
      [orderId]
    );

    const items = poRows.map((r) => ({
      id: r.id,
      product_name: r.product_name,
      product_code: r.product_code,
      qty: r.qty,
      total: r.total,
      status: r.status,
      payment_status: r.payment_status,
      sender_name: r.sender_name,
      sender_phone: r.sender_phone,
      receiver_name: r.receiver_name,
      receiver_phone: r.receiver_phone,
      shipping_address: r.shipping_address,
      greetings: r.greetings,
      notes: r.notes,
      date_time: r.date_time,
      shipped_date: r.shipped_date,
      tracking_number: r.tracking_number,
      shipping_expedition: r.shipping_expedition,
      supplier_name: r.supplier_name,
      po_owner_name: r.po_owner_name,
      flower_rating: r.flower_rating,
      shipping_rating: r.shipping_rating,
      complaint_notes: r.complaint_notes,
      images: {
        product:           toUrl(r.image),
        real:              toUrl(r.real_image),        // foto hasil
        delivery_location: toUrl(r.delivery_location), // foto lokasi
        delivery_receipt:  toUrl(r.delivery_receipt),  // foto tanda terima
      },
    }));

    res.json({
      success: true,
      order: {
        id: order.id,
        order_number: order.order_number,
        status: order.status,
        payment_status: order.payment_status,
        total: order.total,
        all_po_finish: order.all_po_finish,
        min_delivery_date: order.min_delivery_date,
        max_delivery_date: order.max_delivery_date,
        created_at: order.created_at,
        approved_at: order.approved_at,
        order_owner_name: order.order_owner_name,
      },
      items,
    });
  } catch (e) {
    logger.error({ err: e.message, orderId }, '[lotus.order-details] mysql error');
    res.status(500).json({ success: false, message: 'MySQL lookup failed: ' + e.message });
  }
});

module.exports = router;
