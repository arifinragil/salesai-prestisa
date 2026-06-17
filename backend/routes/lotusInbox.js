// /api/lotus-inbox — read & act on conversations from the Lotus PG mirror
// (lotus_conversations DB). Read sources: contacts, messages. Outbound goes
// out via Vonage (vonageAdapter). CRM-side state is stored in crm_lotus_state
// in the main vonage_reports DB.
const express = require('express');
const pg = require('../db/postgres');
const lotus = require('../db/lotus');
const mysql = require('../db/mysql');
const { tabsForItem } = require('../services/lotusTabs');
const { followupState } = require('../services/lotusFollowup');
const { requireStaff } = require('../middleware/auth');
const vonage = require('../services/waAdapters/vonageAdapter');
const { upload, publicUrlFor, attachmentTypeFor } = require('../services/uploadService');
const lotusWebhook = require('../services/lotusWebhook');
const aiClient = require('../services/aiClient');
const persona = require('../services/aiPersona');
const tools = require('../services/aiTools');
const caseLibrary = require('../services/caseLibrary');
const logger = require('../services/logger');
const { promptInstruction: taxonomyPromptInstruction } = require('../services/rootCauseTaxonomy');
const { parseRootCauseFromSummary } = require('../services/rootCauseParser');

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
  const salesList = String(req.query.sales || '')                // lotus assign_to_user_name (CSV → IN)
    .split(',').map((s) => s.trim()).filter(Boolean);
  const limit   = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset  = Math.max(parseInt(req.query.offset) || 0, 0);

  const params = [];
  const where = [];
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(`(LOWER(c.cust_name) LIKE $${params.length} OR c.cust_number LIKE $${params.length})`);
  }
  if (label) { params.push(label); where.push(`c.label = $${params.length}`); }
  if (salesList.length) {
    const placeholders = salesList.map((s) => { params.push(s); return `$${params.length}`; });
    // Match either contacts.assign_to_user_name OR last outbound messages.cs_name.
    where.push(`(c.assign_to_user_name IN (${placeholders.join(',')})
                 OR EXISTS (
                   SELECT 1 FROM messages m
                    WHERE m.cust_number = c.cust_number
                      AND m.direction = 'outbound'
                      AND m.cs_name IN (${placeholders.join(',')})
                 ))`);
  }
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
            COALESCE(lm.direction,   p.last_message_from) AS last_message_from,
            lcs.cs_name AS last_outbound_cs,
            lcs.received_at AS last_outbound_at,
            fim.received_at AS first_inbound_at
     FROM paged p
     LEFT JOIN LATERAL (
       SELECT received_at, body, direction
       FROM messages m
       WHERE m.cust_number = p.cust_number
       ORDER BY received_at DESC NULLS LAST, id DESC
       LIMIT 1
     ) lm ON true
     LEFT JOIN LATERAL (
       SELECT cs_name, received_at
       FROM messages m
       WHERE m.cust_number = p.cust_number
         AND m.direction = 'outbound'
         AND m.cs_name IS NOT NULL
       ORDER BY received_at DESC NULLS LAST, id DESC
       LIMIT 1
     ) lcs ON true
     LEFT JOIN LATERAL (
       SELECT received_at
       FROM messages m
       WHERE m.cust_number = p.cust_number AND m.direction = 'inbound'
       ORDER BY received_at ASC NULLS LAST, id ASC
       LIMIT 1
     ) fim ON true
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
      last_message_at: c.last_message_at,
      last_inbound_at: c.last_inbound_at,
      last_outbound_at: c.last_outbound_at || null,
      unread: c.unread_counter || 0,
      city_name: c.city_name,
      lotus_assign_to: c.assign_to_user_name || c.last_outbound_cs || null,
      lotus_assign_source: c.assign_to_user_name ? 'assigned' : (c.last_outbound_cs ? 'last_cs' : null),
      // CRM state overlay:
      assigned_staff_id: s.assigned_staff_id || null,
      status: s.status || 'active',
      shadow_mode: s.shadow_mode || false,
      snoozed_until: s.snoozed_until || null,
      ai_paused_until: s.ai_paused_until || null,
      lead_temperature: s.lead_temperature || null,
      lead_score: s.lead_score ?? null,
      last_intent: s.last_intent || null,
      root_cause_tag: s.root_cause_tag || null,
      first_inbound_at: s.first_inbound_at || c.first_inbound_at || null,
      first_response_at: s.first_response_at || null,
      handover_count: s.handover_count ?? 0,
    };
  }).filter((it) => {
    const isAdmin = req.staff?.role === 'admin';
    const scope = req.query.scope; // 'mine' | 'team' (admin saja); non-admin selalu 'mine'
    const tab = req.query.tab;
    const effStatus = req.query.status || (tab ? 'active' : null);

    if (effStatus && it.status !== effStatus) return false;

    // Scoping per-user: non-admin hanya lead miliknya; admin default semua (toggle 'mine').
    if (!isAdmin || scope === 'mine') {
      if (it.assigned_staff_id !== req.staff.staff_id) return false;
    }
    // Filter queue lama tetap didukung
    if (queue === 'mine'        && it.assigned_staff_id !== req.staff.staff_id) return false;
    if (queue === 'unassigned'  && it.assigned_staff_id != null) return false;

    // Tab match (all = semua active dalam scope)
    if (tab === 'fu_overdue') {
      if (followupState(it, new Date()).status !== 'overdue') return false;
    } else if (tab === 'fu_stale') {
      if (followupState(it, new Date()).status !== 'expired') return false;
    } else if (tab && tab !== 'all' && !tabsForItem(it, new Date()).includes(tab)) {
      return false;
    }
    return true;
  });

  res.json({ success: true, items, count: items.length, limit, offset });
});

// ── tab-counts: jumlah lead per tab Kanban dalam scope user ───────────────────
const TAB_KEYS = ['urgent', 'hot_asap', 'customer_baru', 'tunggu_balas', 'mau_closing', 'tunggu_cust'];
router.get('/tab-counts', async (req, res) => {
  // Pindai lead aktif 14 hari terakhir (cap 1000) lalu hitung per tab.
  const { rows: contacts } = await lotus.query(
    `WITH recent AS (
       SELECT c.lotus_id, c.cust_number, c.last_message_from, c.last_message_at, c.last_inbound_at
       FROM contacts c
       WHERE GREATEST(c.last_message_at, c.last_inbound_at) >= now() - interval '14 days'
       ORDER BY GREATEST(c.last_message_at, c.last_inbound_at) DESC NULLS LAST
       LIMIT 1000
     )
     SELECT r.lotus_id, r.cust_number,
            COALESCE(lm.direction,   r.last_message_from) AS last_message_from,
            COALESCE(lm.received_at,  r.last_message_at)  AS last_message_at,
            lo.received_at AS last_outbound_at,
            fim.received_at AS first_inbound_at
     FROM recent r
     LEFT JOIN LATERAL (
       SELECT received_at, direction
       FROM messages m
       WHERE m.cust_number = r.cust_number
       ORDER BY received_at DESC NULLS LAST, id DESC
       LIMIT 1
     ) lm ON true
     LEFT JOIN LATERAL (
       SELECT received_at
       FROM messages m
       WHERE m.cust_number = r.cust_number AND m.direction = 'outbound'
       ORDER BY received_at DESC NULLS LAST, id DESC
       LIMIT 1
     ) lo ON true
     LEFT JOIN LATERAL (
       SELECT received_at
       FROM messages m
       WHERE m.cust_number = r.cust_number AND m.direction = 'inbound'
       ORDER BY received_at ASC NULLS LAST, id ASC
       LIMIT 1
     ) fim ON true`
  );
  const stateMap = await getStateMap(contacts.map((c) => c.lotus_id));

  const isAdmin = req.staff?.role === 'admin';
  const scope = req.query.scope;
  const now = new Date();

  const counts = { all: 0 };
  for (const k of TAB_KEYS) counts[k] = 0;
  counts.fu_overdue = 0;
  counts.fu_pending = 0;
  counts.fu_stale = 0;

  for (const c of contacts) {
    const s = stateMap.get(c.lotus_id) || {};
    if ((s.status || 'active') !== 'active') continue;
    if (!isAdmin || scope === 'mine') {
      if ((s.assigned_staff_id ?? null) !== req.staff.staff_id) continue;
    }
    counts.all += 1;
    const item = {
      last_message_from: c.last_message_from,
      last_message_at: c.last_message_at,
      first_inbound_at: s.first_inbound_at || c.first_inbound_at || null,
      lead_temperature: s.lead_temperature || null,
      lead_score: s.lead_score ?? null,
      last_intent: s.last_intent || null,
      root_cause_tag: s.root_cause_tag || null,
      snoozed_until: s.snoozed_until || null,
    };
    for (const k of tabsForItem(item, now)) counts[k] += 1;
    item.last_outbound_at = c.last_outbound_at || null;
    const fu = followupState(item, now);
    if (fu.status === 'overdue') counts.fu_overdue += 1;
    else if (fu.status === 'fresh' || fu.status === 'pending') counts.fu_pending += 1;
    else if (fu.status === 'expired') counts.fu_stale += 1;
  }

  res.json({ success: true, counts });
});

// ── sales-options ──────────────────────────────────────────────────────────
// Distinct sales (assign_to_user_name) dari lotus.contacts, untuk dropdown filter.
router.get('/sales-options', async (_req, res) => {
  // Union of contacts.assign_to_user_name + messages.cs_name (last 90d outbound)
  // — karena assign_to_user_name sering null tapi cs_name selalu terisi saat sales balas.
  const { rows } = await lotus.query(
    `WITH u AS (
       SELECT assign_to_user_name AS name, COUNT(*)::int AS n
         FROM contacts
        WHERE assign_to_user_name IS NOT NULL AND assign_to_user_name <> ''
        GROUP BY 1
       UNION ALL
       SELECT cs_name AS name, COUNT(DISTINCT cust_number)::int AS n
         FROM messages
        WHERE direction = 'outbound'
          AND cs_name IS NOT NULL AND cs_name <> ''
          AND received_at > now() - interval '90 days'
        GROUP BY 1
     )
     SELECT name, SUM(n)::int AS n FROM u GROUP BY name ORDER BY n DESC, name ASC`
  );
  res.json({ success: true, items: rows });
});

// ── contact detail / profile ───────────────────────────────────────────────
router.get('/contacts/:lotus_id', async (req, res) => {
  const id = req.params.lotus_id;
  const c = await getContact(id);
  if (!c) return res.status(404).json({ success: false, message: 'not found' });

  await ensureState(id, c.cust_number);
  const [{ rows: stateRows }, { rows: lastRows }, { rows: csRows }] = await Promise.all([
    pg.query(`SELECT * FROM crm_lotus_state WHERE lotus_id = $1`, [id]),
    lotus.query(
      `SELECT MAX(received_at) AS last_inbound
       FROM messages WHERE cust_number = $1 AND direction = 'inbound'`,
      [c.cust_number]
    ),
    lotus.query(
      `SELECT cs_name FROM messages
        WHERE cust_number = $1 AND direction = 'outbound' AND cs_name IS NOT NULL
        ORDER BY received_at DESC NULLS LAST, id DESC LIMIT 1`,
      [c.cust_number]
    ),
  ]);
  const s = stateRows[0] || {};
  // Override stale aggregate with fresh value from messages
  const freshLastInbound = lastRows[0]?.last_inbound || c.last_inbound_at;
  const lastOutboundCs = csRows[0]?.cs_name || null;

  res.json({
    success: true,
    contact: {
      lotus_id: c.lotus_id, contact_id: c.contact_id,
      cust_number: c.cust_number, cust_name: c.cust_name,
      business_number: c.business_number, label: c.label,
      lead_product: c.lead_product, city_name: c.city_name,
      last_message: c.last_message, last_message_at: c.last_message_at,
      last_inbound_at: freshLastInbound, unread_counter: c.unread_counter,
      lotus_assigned_to: c.assign_to_user_name || lastOutboundCs || null,
      lotus_assigned_source: c.assign_to_user_name ? 'assigned' : (lastOutboundCs ? 'last_cs' : null),
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
  let insertedRowId = null;
  try {
    const { rows: ins } = await lotus.query(
      `INSERT INTO messages
         (lotus_id, message_id, direction, cust_number, cust_name, business_number,
          channel, message_type, body, received_at, created_at, cs_id, cs_name, raw_doc, ingested_at)
       VALUES ($1, $2, 'outbound', $3, $4, $5, 'whatsapp', 'text', $6, now(), now(),
               $7, $8, $9::jsonb, now())
       ON CONFLICT (lotus_id) DO NOTHING
       RETURNING id`,
      [
        msgLotusId, sent.id || null, c.cust_number, c.cust_name, c.business_number,
        body, req.staff.staff_id, req.staff.full_name || req.staff.username || null,
        JSON.stringify({ source: 'salesai_crm', vonage: sent.raw || null }),
      ]
    );
    insertedRowId = ins[0]?.id || null;
  } catch (err) {
    logger.warn({ err: err.message }, '[lotusInbox.send] lotus insert failed (non-fatal)');
  }

  // Notify Lotus app webhook (best-effort, non-blocking)
  lotusWebhook.saveMessage({
    from: senderFrom,
    to: c.cust_number,
    messageId: sent.id || '',
    messageText: body,
    contactName: c.cust_name || 'Customer',
    hsmName: '',
    isHsm: false,
  }).catch(() => {});

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
        id: insertedRowId,
        message_id: sent.id || null,
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
  let insertedRowId = null;
  try {
    const { rows: ins } = await lotus.query(
      `INSERT INTO messages
         (lotus_id, message_id, direction, cust_number, cust_name, business_number,
          channel, message_type, body, received_at, created_at, cs_id, cs_name, raw_doc, ingested_at)
       VALUES ($1, $2, 'outbound', $3, $4, $5, 'whatsapp', $6, $7, now(), now(),
               $8, $9, $10::jsonb, now())
       ON CONFLICT (lotus_id) DO NOTHING
       RETURNING id`,
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
    insertedRowId = ins[0]?.id || null;
  } catch (err) {
    logger.warn({ err: err.message }, '[lotusInbox.send-file] lotus insert failed (non-fatal)');
  }

  // Notify Lotus app webhook (best-effort, non-blocking)
  lotusWebhook.saveMessage({
    from: senderFrom,
    to: c.cust_number,
    messageId: sent.id || '',
    messageText: caption || '',
    contactName: c.cust_name || 'Customer',
    hsmName: '',
    fileName: req.file.originalname,
    fileUrl: url,
    isHsm: false,
  }).catch(() => {});

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
        id: insertedRowId,
        message_id: sent.id || null,
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

  const lastInboundSuggest = [...ctx.messages].reverse().find((m) => m.sender_type === 'customer');
  const inboundBodySuggest = (lastInboundSuggest?.body || '').slice(0, 1000);
  let qnaRefsSuggest = [];
  try { qnaRefsSuggest = await require('../services/qnaRag').retrieveSimilar(inboundBodySuggest, { business_number: ctx.contact.business_number }); } catch (e) {}
  const qnaBlockSuggest = qnaRefsSuggest.length
    ? `\n\nReferensi Q&A yang terbukti baik (pakai sebagai acuan gaya & isi, JANGAN plagiat mentah):\n` +
      qnaRefsSuggest.map((r) => `Q: ${r.question}\nA: ${r.answer}`).join('\n---\n')
    : '';

  const systemPrompt = `${baseSystem}

=== MODE: OPERATOR ASSIST (LOTUS) ===
Saat ini operator manusia handle chat ini di /lotus-inbox. Tugasmu:
- Saran 1 balasan SINGKAT (1-3 kalimat).
- JANGAN pakai tool request_handover.
- Output HANYA teks balasan, tanpa preamble.${qnaBlockSuggest}`;

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

// 4-option reply suggestions (mirrors /inbox CoPilot): 3 case library + 1 AI synth.
// No DB persistence — Lotus mirror tidak punya crm_suggestion_log keyed by lotus_id.
router.post('/contacts/:lotus_id/ai-suggestions', async (req, res) => {
  const id = req.params.lotus_id;
  const ctx = await loadLotusContext(id, 20);
  if (!ctx) return res.status(404).json({ success: false, message: 'not found' });
  if (!ctx.messages.length) return res.status(400).json({ success: false, message: 'belum ada pesan' });

  const lastInbound = [...ctx.messages].reverse().find((m) => m.sender_type === 'customer');
  const inboundBody = (lastInbound?.body || '').slice(0, 1000);
  const t0 = Date.now();

  let caseItems = [];
  let lowConfidence = false;
  try {
    const r = await caseLibrary.lookup({ inboundBody, intent: null });
    caseItems = r.items || [];
    lowConfidence = !!r.lowConfidence;
  } catch (e) {
    logger.warn({ err: e.message }, '[lotus.suggestions] caseLibrary failed');
  }

  const fakeConv = {
    id: 0, phone: ctx.contact.cust_number, push_name: ctx.contact.cust_name,
    customer_id: null, wa_session: 'lotus', shadow_mode: false,
  };
  let sys = '';
  try {
    const baseSystem = await persona.buildSystemPrompt({
      conv: fakeConv, customerName: ctx.contact.cust_name, cityHint: ctx.contact.city_name || null,
    });
    sys = `${baseSystem}\n\n=== MODE: OPERATOR ASSIST (LOTUS) ===\nOperator manusia handle chat ini. JANGAN pakai tool. Output HANYA teks balasan, tanpa preamble.`;
  } catch { /* ignore */ }

  const turns = ctx.messages.slice(-5).map((m) => {
    const who = m.sender_type === 'customer' ? 'Customer'
      : m.sender_type === 'staff' ? 'Operator' : 'Tiara';
    return `${who}: ${(m.body || `[${m.message_type}]`).slice(0, 300)}`;
  }).join('\n');
  let qnaRefs = [];
  try { qnaRefs = await require('../services/qnaRag').retrieveSimilar(inboundBody, { business_number: ctx.contact.business_number }); } catch (e) {}
  const qnaBlock = qnaRefs.length
    ? `\n\nReferensi Q&A yang terbukti baik (pakai sebagai acuan gaya & isi, JANGAN plagiat mentah):\n` +
      qnaRefs.map((r) => `Q: ${r.question}\nA: ${r.answer}`).join('\n---\n')
    : '';

  const casesBlock = caseItems.map((c, i) => `${i + 1}. ${c.body}`).join('\n') || '(belum ada saran case)';
  const aiPrompt = `Customer message terbaru: "${inboundBody || '(tidak ada teks)'}"
Last 5 turns:
${turns}

Saran case library:
${casesBlock}

Tugas: tulis 1 reply ALTERNATIF — synthesize/improve dari saran di atas dengan persona Tiara.
Constraint:
- Bahasa Indonesia santai-sopan, sapaan "Kak"
- 1-3 kalimat, max 200 kata
- Tambah CTA bila relevan
- Output: HANYA text reply, tanpa preamble/quote/label.`;

  const AI_TIMEOUT_MS = parseInt(process.env.COPILOT_AI_TIMEOUT_MS) || 6000;
  let aiText = null;
  let aiErr = null;
  const ta = Date.now();
  try {
    const resp = await Promise.race([
      aiClient.complete({
        system: sys,
        messages: [{ role: 'user', content: aiPrompt + qnaBlock }],
        max_tokens: 400, temperature: 0.4,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('ai_timeout')), AI_TIMEOUT_MS)),
    ]);
    aiText = (resp?.text || '').trim() || null;
  } catch (e) {
    aiErr = e.message;
    logger.warn({ err: e.message, lotusId: id }, '[lotus.suggestions] ai failed');
  }
  const aiMs = Date.now() - ta;

  const options = caseItems.slice(0, 3).map((c, i) => ({
    rank: i + 1,
    source: 'case',
    case_label: c.case_label,
    text: c.body,
    confidence: lowConfidence ? 'low' : 'normal',
  }));
  while (options.length < 3) {
    options.push({
      rank: options.length + 1, source: 'fallback',
      text: 'Halo Kak, boleh dijelaskan lebih lanjut kebutuhannya supaya Tiara bantu lebih akurat ya?',
      confidence: 'low',
    });
  }
  options.push({
    rank: 4,
    source: aiText ? 'ai' : 'fallback',
    text: aiText || 'Tidak ada usulan AI — gunakan opsi 1-3 atau ketik manual.',
    confidence: aiText ? (lowConfidence ? 'low' : 'normal') : 'low',
    ai_ms: aiMs, ai_error: aiErr,
  });

  let sugLogId = null;
  try {
    const lg = await pg.query(
      `INSERT INTO crm_lotus_suggestion_log (lotus_id, cust_number, options, staff_id) VALUES ($1,$2,$3::jsonb,$4) RETURNING id`,
      [id, ctx?.contact?.cust_number || null, JSON.stringify(options), req.staff.staff_id]
    );
    sugLogId = lg.rows[0].id;
  } catch (e) {}

  res.json({
    success: true,
    options,
    log_id: sugLogId,
    generation_ms: Date.now() - t0,
    low_confidence: lowConfidence,
    inbound_preview: inboundBody.slice(0, 120),
  });
});

// POST /contacts/:lotus_id/suggestion/:logId/used — catat pemakaian saran Lotus
router.post('/contacts/:lotus_id/suggestion/:logId/used', async (req, res, next) => {
  try {
    const { picked_rank, usage_type, edit_distance } = req.body || {};
    const ut = ['raw', 'edited', 'manual'].includes(usage_type) ? usage_type : null;
    await pg.query(
      `UPDATE crm_lotus_suggestion_log SET picked_rank = $2, usage_type = $3, edit_distance = $4 WHERE id = $1`,
      [parseInt(req.params.logId), picked_rank ?? null, ut, edit_distance ?? null]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /contacts/:lotus_id/suggestion/:logId/rate — 👍 feeds Q&A, 👎 flags
router.post('/contacts/:lotus_id/suggestion/:logId/rate', async (req, res, next) => {
  try {
    const { vote, question, answer, note } = req.body || {};
    if (vote === 'up') {
      if (question && answer) {
        await require('../services/qnaRag').upsertQna({ question, answer, source: 'rated', created_by: req.staff.staff_id });
      }
      await pg.query(`UPDATE crm_lotus_suggestion_log SET flagged_reason = 'good' WHERE id = $1`, [parseInt(req.params.logId)]).catch(() => {});
    } else if (vote === 'down') {
      await pg.query(`UPDATE crm_lotus_suggestion_log SET flagged_reason = 'bad_suggestion', flagged_note = $2 WHERE id = $1`, [parseInt(req.params.logId), note || null]).catch(() => {});
    } else {
      return res.status(400).json({ error: 'bad_vote' });
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/contacts/:lotus_id/ai-summary', async (req, res) => {
  const id = req.params.lotus_id;
  const force = !!(req.body && req.body.force);
  const ctx = await loadLotusContext(id, 60);
  if (!ctx) return res.status(404).json({ success: false, message: 'not found' });
  if (!ctx.messages.length) return res.status(400).json({ success: false, message: 'belum ada pesan' });

  // Cache check — skip kalau sudah ada summary & tidak ada pesan baru
  if (!force) {
    const cached = await pg.query(
      `SELECT ai_summary, ai_summary_msg_count, ai_summary_generated_at
         FROM crm_lotus_state WHERE lotus_id = $1 LIMIT 1`,
      [id]
    );
    const c = cached.rows[0];
    const lastMsgAt = ctx.messages[ctx.messages.length - 1]?.received_at || ctx.messages[ctx.messages.length - 1]?.created_at;
    if (c && c.ai_summary && c.ai_summary_generated_at && lastMsgAt &&
        new Date(c.ai_summary_generated_at) >= new Date(lastMsgAt)) {
      return res.json({
        success: true,
        summary: c.ai_summary,
        message_count: c.ai_summary_msg_count || ctx.messages.length,
        generated_at: c.ai_summary_generated_at,
        source: 'cached',
      });
    }
  }

  const transcript = ctx.messages.map((m) => {
    const who = m.sender_type === 'customer' ? 'Customer'
      : m.sender_type === 'staff' ? 'Operator' : 'Tiara';
    return `${who}: ${(m.body || `[${m.message_type}]`).slice(0, 300)}`;
  }).join('\n');

  const systemPrompt = `Kamu analyst CS/Sales Prestisa. Tugasmu menganalisis percakapan WhatsApp (data dari Lotus) dan menghasilkan ringkasan tajam untuk operator + manajer sales. Bahasa Indonesia, ringkas, berbasis bukti dari transkrip. Jangan mengarang fakta — kalau data tidak ada, tulis "Tidak ditemukan".`;
  const userMsg = `Analisa percakapan berikut. Output WAJIB pakai 4 section persis di bawah ini, dengan heading tebal seperti format ini:

## A. 5 Why (Root Cause Analysis)
**Why 1 — Alasan Customer Tidak Membeli / Hambatan Utama:** apa alasan langsung yang disampaikan atau terlihat di transkrip.
**Why 2 — Penyebab Alasan Tersebut Muncul:** kenapa alasan itu muncul (mis. pembanding harga, ekspektasi, pengalaman sebelumnya).
**Why 3 — Kelemahan pada Penawaran atau Handling:** kenapa customer memilih alternatif / ragu — fokus ke gap di penawaran sales.
**Why 4 — Penyebab pada Proses atau Sistem:** kenapa sales tidak menutup gap itu (template, SOP, info produk, tools).
**Why 5 — Akar Masalah Manajerial:** kenapa proses/sistem itu belum tersedia / tidak dijalankan.
**Root Cause:** 1-2 kalimat akar masalah sebenarnya (bukan gejala permukaan).
**Corrective Action:** 1-2 kalimat tindakan korektif sistemik (bukan sekadar follow-up customer ini).

## B. POV Customer
**Kebutuhan inti:** apa yang sebenarnya customer cari.
**Sentiment emosional:** netral / antusias / frustrasi / kecewa — sebut tone-nya.
**Kepuasan terhadap handling sales:** emoji (😊 / 😐 / 😞) + 1 kalimat alasan + contoh quote singkat dari transkrip.
**Urgency:** santai / normal / mendesak — sebutkan sinyalnya.
**Pain point / keraguan:** hal yang bikin customer ragu atau tidak nyaman.
**Ekspektasi tidak terpenuhi:** apa yang customer harapkan tapi tidak dapat (tulis "Tidak ditemukan" kalau tidak ada).

## C. POV Kinerja Sales
### ✅ Yang Sudah Baik (Good)
List 1-3 poin. Tiap poin: nama aspek + 1 kalimat penjelasan + 1 contoh quote dari transkrip. Tulis "Tidak ditemukan" kalau memang tidak ada.

### ❌ Problem yang Teridentifikasi (Problem)
List 1-4 poin. Evaluasi minimal dimensi ini bila relevan: response speed, kelengkapan info produk/harga, empathy & active listening, closing skill / CTA, akurasi info. Tiap poin: nama aspek + 1 kalimat penjelasan + 1 contoh konkret dari transkrip.

## D. Action To Do
**Status percakapan:** sudah selesai / butuh tindakan operator / menunggu customer.
**Risk assessment:** churn (low/med/high) + potensi closing (low/med/high), masing-masing 1 alasan singkat.
**Next action prioritas (1-3 item):** format \`[P1] judul: detail — deadline\`.
**Coaching note untuk sales:** 1-2 kalimat tips spesifik berbasis observasi di transkrip ini.
**Pola yang perlu di-monitor:** pola berulang yang sebaiknya manajer pantau ke depan.

Aturan:
- Jangan tambah section lain di luar A–D.
- Pakai bukti dari transkrip (quote singkat) bila relevan.
- Kalau info kurang untuk suatu poin, tulis "Tidak ditemukan" — jangan mengarang.

---

${taxonomyPromptInstruction()}

Transkrip (${ctx.messages.length} pesan):
${transcript}`;

  // AI Summary pakai Gemini 2.5 Flash (gratis tier) — hemat token vs Claude.
  // Reply generation tetap pakai provider aktif (Claude default).
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    return res.status(500).json({ success: false, message: 'GEMINI_API_KEY belum di-set' });
  }

  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(geminiKey);

    let llmText = '';
    let usage = null;
    const tryModel = async (modelName) => {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemPrompt,
        generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
      });
      const r = await model.generateContent(userMsg);
      const u = r.response.usageMetadata || {};
      return {
        text: r.response.text().trim(),
        usage: { input_tokens: u.promptTokenCount || 0, output_tokens: u.candidatesTokenCount || 0 },
      };
    };

    try {
      const out = await tryModel('gemini-2.5-flash');
      llmText = out.text; usage = out.usage;
    } catch (err) {
      const msg = String(err);
      if (msg.includes('429') || msg.includes('503')) {
        await new Promise(r => setTimeout(r, 3000));
        const out = await tryModel('gemini-2.5-flash-lite');
        llmText = out.text; usage = out.usage;
      } else throw err;
    }

    const parsed = parseRootCauseFromSummary(llmText);
    const summary = parsed.summary;
    const rootCauseTag = parsed.tag;
    const rootCauseConfidence = parsed.confidence;
    await ensureState(id, ctx.contact.cust_number);
    await pg.query(
      `UPDATE crm_lotus_state
         SET ai_summary = $2,
             ai_summary_msg_count = $3,
             ai_summary_generated_at = now(),
             root_cause_tag = $4::text,
             root_cause_confidence = $5::numeric,
             root_cause_tagged_at = CASE WHEN $4::text IS NOT NULL THEN now() ELSE root_cause_tagged_at END,
             updated_at = now()
       WHERE lotus_id = $1`,
      [id, summary, ctx.messages.length, rootCauseTag, rootCauseConfidence]
    );
    res.json({
      success: true, summary, message_count: ctx.messages.length,
      generated_at: new Date().toISOString(),
      source: 'gemini-2.5-flash', usage,
      root_cause_tag: rootCauseTag,
      root_cause_confidence: rootCauseConfidence,
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
  let insertedRowId = null;
  try {
    const { rows: ins } = await lotus.query(
      `INSERT INTO messages
         (lotus_id, message_id, direction, cust_number, cust_name, business_number,
          channel, message_type, body, hsm_name, received_at, created_at, cs_id, cs_name, raw_doc, ingested_at)
       VALUES ($1, $2, 'outbound', $3, $4, $5, 'whatsapp', 'template', $6, $7, now(), now(),
               $8, $9, $10::jsonb, now())
       ON CONFLICT (lotus_id) DO NOTHING
       RETURNING id`,
      [
        msgLotusId, sent.id || null, c.cust_number, c.cust_name, c.business_number,
        rendered, templateName, req.staff.staff_id,
        req.staff.full_name || req.staff.username || null,
        JSON.stringify({ source: 'salesai_crm', template: templateName, params, vonage: sent.raw || null }),
      ]
    );
    insertedRowId = ins[0]?.id || null;
  } catch (err) {
    logger.warn({ err: err.message }, '[lotusInbox.send-template] lotus insert failed');
  }

  // Notify Lotus app webhook (best-effort, non-blocking)
  lotusWebhook.saveMessage({
    from: senderFrom,
    to: c.cust_number,
    messageId: sent.id || '',
    messageText: rendered,
    contactName: c.cust_name || 'Customer',
    hsmName: templateName,
    fileName: tpl.header_image ? (tpl.header_image.split('/').pop() || 'header') : '',
    fileUrl: tpl.header_image || '',
    isHsm: true,
  }).catch(() => {});

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
        id: insertedRowId,
        message_id: sent.id || null,
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

const { runTierA } = require('../services/analystReport');

// POST /api/lotus-inbox/contacts/:lotus_id/analyst-report
// Body: { force?: boolean, tier?: 'A' | 'B' }
router.post('/contacts/:lotus_id/analyst-report', async (req, res) => {
  const id = req.params.lotus_id;
  const force = !!(req.body && req.body.force);
  const tier = (req.body && req.body.tier) || 'A';
  if (tier !== 'A' && tier !== 'B') return res.status(400).json({ success: false, code: 'INVALID_TIER' });

  const ctx = await loadLotusContext(id, 100);
  if (!ctx) return res.status(404).json({ success: false, message: 'not found' });
  if (!ctx.messages.length) return res.status(400).json({ success: false, message: 'belum ada pesan' });

  const inboundCount = ctx.messages.filter(m => m.sender_type === 'customer').length;
  if (tier === 'A' && inboundCount < 4) {
    return res.status(400).json({ success: false, code: 'INBOUND_TOO_LOW', inbound_count: inboundCount, threshold: 4 });
  }

  // Tier A cache check
  if (tier === 'A' && !force) {
    const c = (await pg.query(
      `SELECT lead_status, funnel_stage_lost, customer_intent, no_response_after, controllability,
              decision_maker, internal_root_cause_categories, sales_handling, product_solution_fit,
              confidence_v2, evidence_quote, root_cause_tag,
              analyst_report_generated_at, analyst_report_msg_count, analyst_summary_md, analyst_summary_generated_at
         FROM crm_lotus_state WHERE lotus_id = $1`,
      [id]
    )).rows[0];
    if (c && c.analyst_report_generated_at && c.analyst_report_msg_count >= ctx.messages.length) {
      return res.json({
        success: true, source: 'cached', tier: 'A',
        inbound_count: inboundCount, message_count: ctx.messages.length,
        structured: {
          customer_reason: c.root_cause_tag,
          lead_status: c.lead_status, funnel_stage_lost: c.funnel_stage_lost,
          customer_intent: c.customer_intent, no_response_after: c.no_response_after,
          controllability: c.controllability, decision_maker: c.decision_maker,
          internal_root_cause_categories: c.internal_root_cause_categories || [],
          sales_handling: c.sales_handling, product_solution_fit: c.product_solution_fit,
          confidence: c.confidence_v2, evidence_quote: c.evidence_quote,
        },
        summary_md: c.analyst_summary_md || null,
        summary_generated_at: c.analyst_summary_generated_at,
        generated_at: c.analyst_report_generated_at,
      });
    }
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return res.status(500).json({ success: false, message: 'GEMINI_API_KEY belum di-set' });

  const transcript = ctx.messages.map(m => {
    const who = m.sender_type === 'customer' ? 'Customer'
      : m.sender_type === 'staff' ? 'Operator' : 'Tiara';
    return `${who}: ${(m.body || `[${m.message_type}]`).slice(0, 300)}`;
  }).join('\n');

  if (tier === 'A') {
    try {
      const corrections = (await pg.query(
        `SELECT corrected_root_cause AS to, corrected_reason AS reason FROM crm_lead_supervisor_actions
         WHERE action='revise_ai' AND corrected_root_cause IS NOT NULL ORDER BY created_at DESC LIMIT 15`
      )).rows;

      const { validated, usage, duration_ms } = await runTierA({
        transcript, msgCount: ctx.messages.length, inboundCount, geminiKey, corrections
      });

      await pg.query(
        `INSERT INTO crm_lotus_state (lotus_id, root_cause_tag,
            lead_status, funnel_stage_lost, customer_intent, no_response_after,
            controllability, decision_maker, internal_root_cause_categories,
            sales_handling, product_solution_fit, confidence_v2, evidence_quote,
            stuck_group, stuck_issue,
            analyst_report_generated_at, analyst_report_msg_count, root_cause_tagged_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now(), $16, now())
         ON CONFLICT (lotus_id) DO UPDATE SET
            root_cause_tag                 = EXCLUDED.root_cause_tag,
            lead_status                    = EXCLUDED.lead_status,
            funnel_stage_lost              = EXCLUDED.funnel_stage_lost,
            customer_intent                = EXCLUDED.customer_intent,
            no_response_after              = EXCLUDED.no_response_after,
            controllability                = EXCLUDED.controllability,
            decision_maker                 = EXCLUDED.decision_maker,
            internal_root_cause_categories = EXCLUDED.internal_root_cause_categories,
            sales_handling                 = EXCLUDED.sales_handling,
            product_solution_fit           = EXCLUDED.product_solution_fit,
            confidence_v2                  = EXCLUDED.confidence_v2,
            evidence_quote                 = EXCLUDED.evidence_quote,
            stuck_group                    = EXCLUDED.stuck_group,
            stuck_issue                    = EXCLUDED.stuck_issue,
            analyst_report_generated_at    = now(),
            analyst_report_msg_count       = EXCLUDED.analyst_report_msg_count,
            root_cause_tagged_at           = now()`,
        [
          id, validated.customer_reason,
          validated.lead_status, validated.funnel_stage_lost, validated.customer_intent, validated.no_response_after,
          validated.controllability, validated.decision_maker, validated.internal_root_cause_categories,
          validated.sales_handling, validated.product_solution_fit, validated.confidence, validated.evidence_quote,
          validated.stuck_group, validated.stuck_issue,
          ctx.messages.length,
        ]
      );
      logger.info({ lotus_id: id, tier: 'A', msg_count: ctx.messages.length, inbound_count: inboundCount,
                    tokens_in: usage.input_tokens, tokens_out: usage.output_tokens, duration_ms, source: 'fresh' },
                  '[analyst.report]');
      return res.json({
        success: true, source: 'fresh', tier: 'A',
        inbound_count: inboundCount, message_count: ctx.messages.length,
        structured: { ...validated, customer_reason: validated.customer_reason },
        summary_md: null,
        confidence: validated.confidence,
        generated_at: new Date().toISOString(),
      });
    } catch (e) {
      logger.error({ err: e.message, lotus_id: id, tier: 'A' }, '[analyst.report] failed');
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  // Tier B
  if (inboundCount < 5) {
    return res.status(400).json({ success: false, code: 'INBOUND_TOO_LOW_FOR_TIER_B', inbound_count: inboundCount, threshold: 5 });
  }
  const stateRow = (await pg.query(
    `SELECT lead_status, funnel_stage_lost, customer_intent, no_response_after, controllability,
            decision_maker, internal_root_cause_categories, sales_handling, product_solution_fit,
            confidence_v2, evidence_quote, root_cause_tag,
            analyst_report_generated_at, analyst_report_msg_count, analyst_summary_md, analyst_summary_generated_at
       FROM crm_lotus_state WHERE lotus_id = $1`,
    [id]
  )).rows[0];
  if (!stateRow || !stateRow.analyst_report_generated_at) {
    return res.status(400).json({ success: false, code: 'TIER_A_MISSING', message: 'Generate Tier A dulu sebelum Tier B' });
  }
  if (!force && stateRow.analyst_summary_md && stateRow.analyst_report_msg_count >= ctx.messages.length) {
    return res.json({
      success: true, source: 'cached', tier: 'B',
      inbound_count: inboundCount, message_count: ctx.messages.length,
      structured: null,
      summary_md: stateRow.analyst_summary_md,
      summary_generated_at: stateRow.analyst_summary_generated_at,
    });
  }
  const tierAContext = {
    customer_reason: stateRow.root_cause_tag,
    internal_root_cause_categories: stateRow.internal_root_cause_categories || [],
    funnel_stage_lost: stateRow.funnel_stage_lost,
    controllability: stateRow.controllability,
    sales_handling: stateRow.sales_handling,
  };
  try {
    const { runTierB } = require('../services/analystReport');
    const { markdown, usage, duration_ms } = await runTierB({
      tierA: tierAContext, transcript, msgCount: ctx.messages.length, geminiKey,
    });
    await pg.query(
      `UPDATE crm_lotus_state SET analyst_summary_md = $2, analyst_summary_generated_at = now()
        WHERE lotus_id = $1`,
      [id, markdown]
    );
    logger.info({ lotus_id: id, tier: 'B', msg_count: ctx.messages.length, inbound_count: inboundCount,
                  tokens_in: usage.input_tokens, tokens_out: usage.output_tokens, duration_ms, source: 'fresh' },
                '[analyst.report]');
    return res.json({
      success: true, source: 'fresh', tier: 'B',
      inbound_count: inboundCount, message_count: ctx.messages.length,
      structured: null, summary_md: markdown,
      summary_generated_at: new Date().toISOString(),
    });
  } catch (e) {
    logger.error({ err: e.message, lotus_id: id, tier: 'B' }, '[analyst.report] failed');
    return res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
