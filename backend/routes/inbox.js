const express = require('express');
const pg = require('../db/postgres');
const { requireStaff } = require('../middleware/auth');
const waClient = require('../services/waClient');
const notify = require('../services/notify');
const logger = require('../services/logger');
const aiClient = require('../services/aiClient');
const tools = require('../services/aiTools');
const persona = require('../services/aiPersona');
const { resolveByPhone } = require('../services/contactResolver');
const { upload, publicUrlFor, attachmentTypeFor } = require('../services/uploadService');

const router = express.Router();
router.use(requireStaff);

router.get('/conversations', async (req, res) => {
  const status = req.query.status;
  const session = req.query.wa_session;
  const search = (req.query.search || '').toString().trim().toLowerCase();
  const queue = req.query.queue; // 'mine' | 'unassigned' | 'team'
  const tagId = parseInt(req.query.tag_id) || null;
  const sort = req.query.sort || 'recent'; // 'recent' | 'temp'
  const params = [];
  const where = [];
  if (status && ['active', 'closed', 'spam'].includes(status)) {
    params.push(status);
    where.push(`conv.status = $${params.length}`);
  }
  if (session) {
    params.push(session);
    where.push(`conv.wa_session = $${params.length}`);
  }
  if (queue === 'mine') {
    params.push(req.staff.staff_id);
    where.push(`conv.assigned_staff_id = $${params.length}`);
  } else if (queue === 'unassigned') {
    where.push(`conv.assigned_staff_id IS NULL`);
  }
  if (tagId) {
    params.push(tagId);
    where.push(`EXISTS (SELECT 1 FROM crm_conversation_tags ct WHERE ct.conversation_id = conv.id AND ct.tag_id = $${params.length})`);
  }
  if (req.query.pipeline_stage) {
    params.push(req.query.pipeline_stage);
    where.push(`conv.pipeline_stage = $${params.length}`);
  }
  // Role-based visibility: acquisition + retention only see their assigned convs.
  // Other roles (admin, operator, viewer, staff) see all.
  const ROLE_PRIVATE = new Set(['acquisition', 'retention']);
  if (ROLE_PRIVATE.has(req.staff.role)) {
    params.push(req.staff.staff_id);
    where.push(`conv.assigned_staff_id = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `
    WITH last_msg AS (
      SELECT DISTINCT ON (conversation_id)
        conversation_id, body, sender_type, created_at
      FROM crm_messages
      ORDER BY conversation_id, id DESC
    ),
    handover_open AS (
      SELECT conversation_id, COUNT(*)::int AS n
      FROM crm_handovers WHERE resolved_at IS NULL GROUP BY conversation_id
    ),
    conv_tags AS (
      SELECT ct.conversation_id,
             json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color, 'auto', COALESCE(ct.auto_tagged, FALSE)) ORDER BY t.name) AS tags
      FROM crm_conversation_tags ct JOIN crm_tags t ON t.id = ct.tag_id
      GROUP BY ct.conversation_id
    )
    SELECT conv.id, conv.phone, conv.real_phone, conv.push_name,
           conv.customer_id, conv.status, conv.ai_enabled,
           conv.ai_paused_until, conv.assigned_staff_id, conv.last_message_at,
           conv.last_intent, conv.lead_temperature, conv.lead_score,
           conv.handover_count, conv.shadow_mode, conv.wa_session,
           conv.experiment_variant,
           conv.pipeline_stage, conv.pipeline_type, conv.manual_stage_override,
           lm.body AS last_body, lm.sender_type AS last_sender, lm.created_at AS last_at,
           COALESCE(ho.n, 0) AS open_handovers,
           COALESCE(ct.tags, '[]'::json) AS tags
    FROM crm_conversations conv
    LEFT JOIN last_msg lm ON lm.conversation_id = conv.id
    LEFT JOIN handover_open ho ON ho.conversation_id = conv.id
    LEFT JOIN conv_tags ct ON ct.conversation_id = conv.id
    ${whereSql}
    ${sort === 'temp'
      ? `ORDER BY CASE conv.lead_temperature WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END,
                  conv.lead_score DESC NULLS LAST,
                  COALESCE(conv.last_message_at, conv.updated_at) DESC`
      : `ORDER BY COALESCE(conv.last_message_at, conv.updated_at) DESC`}
    LIMIT 200`;
  const { rows } = await pg.query(sql, params);
  const items = search
    ? rows.filter((r) =>
        (r.phone || '').includes(search) ||
        (r.real_phone || '').includes(search) ||
        (r.push_name || '').toLowerCase().includes(search))
    : rows;
  res.json({ success: true, items });
});

// Distinct WAHA sessions seen in DB — used by inbox UI for filter dropdown
router.get('/wa-sessions', async (_req, res) => {
  const { rows } = await pg.query(
    `SELECT wa_session AS name, COUNT(*)::int AS count
     FROM crm_conversations
     WHERE wa_session IS NOT NULL
     GROUP BY wa_session
     ORDER BY count DESC`
  );
  res.json({ success: true, items: rows });
});

// Proxy WAHA media files (customer-sent images/audio/video) through our
// backend so the browser can fetch them — WAHA's media URL is private.
router.get('/waha-media/:session/:filename', async (req, res) => {
  const { session, filename } = req.params;
  if (!/^[a-zA-Z0-9_-]{2,64}$/.test(session) || !/^[a-zA-Z0-9._-]+$/.test(filename)) {
    return res.status(400).json({ success: false, message: 'invalid path' });
  }
  const base = process.env.WAHA_API_URL || 'http://localhost:3000';
  const upstream = `${base}/api/files/${encodeURIComponent(session)}/${encodeURIComponent(filename)}`;
  try {
    const r = await fetch(upstream, {
      headers: process.env.WAHA_API_KEY ? { 'X-Api-Key': process.env.WAHA_API_KEY } : {},
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return res.status(r.status).json({ success: false, message: txt.slice(0, 200) });
    }
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (err) {
    res.status(502).json({ success: false, message: err.message });
  }
});

// Search across all messages (and customer phones) — operator-wide.
router.get('/messages/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.status(400).json({ success: false, message: 'q minimum 2 chars' });
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);

  const { rows } = await pg.query(
    `SELECT m.id, m.created_at, m.direction, m.sender_type, m.body,
            c.id AS conversation_id, c.phone, c.customer_id
     FROM crm_messages m
     JOIN crm_conversations c ON c.id = m.conversation_id
     WHERE m.body ILIKE $1 OR c.phone ILIKE $1
     ORDER BY m.id DESC
     LIMIT $2`,
    [`%${q}%`, limit]
  );
  res.json({ success: true, query: q, count: rows.length, results: rows });
});

// CSV export of full conversation transcript
router.get('/conversations/:id/export.csv', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  const c = await pg.query(`SELECT phone FROM crm_conversations WHERE id = $1`, [id]);
  if (!c.rows[0]) return res.status(404).json({ success: false, message: 'not found' });

  const { rows } = await pg.query(
    `SELECT id, created_at, direction, sender_type, staff_id, body, message_type,
            attachment_url, send_status,
            ai_metadata->>'provider' AS ai_provider,
            ai_metadata->>'model' AS ai_model,
            ai_metadata->>'tools_called' AS ai_tools
     FROM crm_messages WHERE conversation_id = $1 ORDER BY id ASC`,
    [id]
  );

  function csvEscape(v) {
    if (v == null) return '';
    const s = typeof v === 'string' ? v : String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  const header = ['id', 'timestamp', 'direction', 'sender_type', 'staff_id', 'message_type',
    'body', 'attachment_url', 'send_status', 'ai_provider', 'ai_model', 'ai_tools'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.id,
      r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      r.direction, r.sender_type, r.staff_id || '', r.message_type || 'text',
      csvEscape(r.body), r.attachment_url || '', r.send_status || '',
      r.ai_provider || '', r.ai_model || '', r.ai_tools || '',
    ].join(','));
  }
  const csv = lines.join('\n') + '\n';
  const phone = c.rows[0].phone.replace(/[^a-zA-Z0-9]/g, '');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="conv-${id}-${phone}.csv"`);
  res.send(csv);
});

router.get('/conversations/:id/messages', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  const { rows } = await pg.query(
    `SELECT m.id, m.direction, m.sender_type, m.staff_id, m.body, m.message_type, m.attachment_url,
            m.ai_metadata, m.shadow, m.send_status, m.created_at, m.sentiment, m.pii_flags, m.feedback,
            u.full_name AS staff_name, u.username AS staff_username
     FROM crm_messages m
     LEFT JOIN staff_users u ON u.id = m.staff_id
     WHERE m.conversation_id = $1
     ORDER BY m.id ASC LIMIT 500`,
    [id]
  );
  res.json({ success: true, messages: rows });
});

router.post('/conversations/:id/send', async (req, res) => {
  const id = parseInt(req.params.id);
  const body = (req.body?.body || '').toString().trim();
  if (!id || !body) return res.status(400).json({ success: false, message: 'id and body required' });

  const conv = await pg.query(`SELECT phone FROM crm_conversations WHERE id = $1`, [id]);
  if (!conv.rows[0]) return res.status(404).json({ success: false, message: 'conversation not found' });

  let sent;
  try {
    sent = await waClient.sendText({ phone: conv.rows[0].phone, text: body });
  } catch (err) {
    logger.error({ err: err.message, convId: id }, '[inbox.send] waha failed');
    return res.status(502).json({ success: false, message: `WAHA send failed: ${err.message}` });
  }

  const ins = await pg.query(
    `INSERT INTO crm_messages (conversation_id, direction, sender_type, staff_id, body, message_type, send_status, waha_message_id)
     VALUES ($1, 'out', 'staff', $2, $3, 'text', 'sent', $4)
     RETURNING id, created_at`,
    [id, req.staff.staff_id, body, sent.id || null]
  );
  await pg.query(`UPDATE crm_conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`, [id]);
  // Set first_response_at on the first operator outbound after an inbound (idempotent).
  await pg.query(
    `UPDATE crm_conversations SET first_response_at = COALESCE(first_response_at, now())
     WHERE id = $1 AND first_inbound_at IS NOT NULL`,
    [id]
  );

  notify.notifyMessage({
    conversation_id: id,
    message: { id: ins.rows[0].id, direction: 'out', sender_type: 'staff', staff_id: req.staff.staff_id, body, created_at: ins.rows[0].created_at },
  });
  res.json({ success: true, message_id: ins.rows[0].id });
});

router.post('/conversations/:id/send-file', upload.single('file'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  if (!req.file) return res.status(400).json({ success: false, message: 'file required (multipart field "file")' });

  const conv = await pg.query(`SELECT phone FROM crm_conversations WHERE id = $1`, [id]);
  if (!conv.rows[0]) return res.status(404).json({ success: false, message: 'conversation not found' });

  const url = publicUrlFor(req.file.filename);
  const type = attachmentTypeFor(req.file.mimetype);
  const caption = (req.body?.caption || '').toString().trim() || null;

  let sent;
  try {
    if (type === 'image') {
      sent = await waClient.sendImage({ phone: conv.rows[0].phone, imageUrl: url, caption });
    } else {
      sent = await waClient.sendFile({
        phone: conv.rows[0].phone,
        fileUrl: url,
        mimetype: req.file.mimetype,
        filename: req.file.originalname,
        caption,
      });
    }
  } catch (err) {
    logger.error({ err: err.message, convId: id }, '[inbox.send-file] waha failed');
    return res.status(502).json({ success: false, message: `WAHA send failed: ${err.message}` });
  }

  const ins = await pg.query(
    `INSERT INTO crm_messages
       (conversation_id, direction, sender_type, staff_id, body, message_type, attachment_url, send_status, waha_message_id)
     VALUES ($1, 'out', 'staff', $2, $3, $4, $5, 'sent', $6)
     RETURNING id, created_at`,
    [id, req.staff.staff_id, caption, type, url, sent.id || null]
  );
  await pg.query(`UPDATE crm_conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`, [id]);

  notify.notifyMessage({
    conversation_id: id,
    message: {
      id: ins.rows[0].id, direction: 'out', sender_type: 'staff', staff_id: req.staff.staff_id,
      body: caption, message_type: type, attachment_url: url,
      created_at: ins.rows[0].created_at,
    },
  });
  res.json({
    success: true, message_id: ins.rows[0].id, attachment_url: url,
    type, size: req.file.size, mimetype: req.file.mimetype,
  });
});

router.post('/conversations/:id/takeover', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  await pg.query(
    `UPDATE crm_conversations
       SET ai_paused_until = now() + INTERVAL '24 hours',
           assigned_staff_id = $2, updated_at = now()
     WHERE id = $1`,
    [id, req.staff.staff_id]
  );
  notify.notifyConvUpdated(id);
  res.json({ success: true });
});

router.post('/conversations/:id/resume-ai', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  await pg.query(
    `UPDATE crm_conversations SET ai_paused_until = NULL, updated_at = now() WHERE id = $1`, [id]
  );
  notify.notifyConvUpdated(id);
  res.json({ success: true });
});

router.post('/conversations/:id/close', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  await pg.query(`UPDATE crm_conversations SET status = 'closed', updated_at = now() WHERE id = $1`, [id]);
  notify.notifyConvUpdated(id);
  res.json({ success: true });
});

// Set the operator-entered real phone for LID-locked conversations.
// Triggers customer lookup so the conv links to MySQL customer profile.
router.post('/conversations/:id/set-phone', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });

  const raw = (req.body?.phone || '').toString().trim();
  // Normalize: strip all non-digits, accept Indonesian formats (0xxx, 8xxx, 62xxx, +62xxx)
  let phone = raw.replace(/\D/g, '');
  if (!phone) {
    // empty = clear the override
    await pg.query(`UPDATE crm_conversations SET real_phone = NULL, customer_id = NULL WHERE id = $1`, [id]);
    return res.json({ success: true, real_phone: null, customer_id: null });
  }
  if (phone.startsWith('0')) phone = '62' + phone.slice(1);
  else if (phone.startsWith('8')) phone = '62' + phone;
  if (phone.length < 10 || phone.length > 16) {
    return res.status(400).json({ success: false, message: 'phone harus 10-16 digit' });
  }

  // Resolve to MySQL customer
  let customerId = null;
  try {
    const r = await resolveByPhone(phone);
    customerId = r.customer_id;
  } catch (err) {
    logger.warn({ err: err.message }, '[set-phone] resolve failed');
  }

  await pg.query(
    `UPDATE crm_conversations SET real_phone = $2, customer_id = $3, updated_at = now() WHERE id = $1`,
    [id, phone, customerId]
  );
  res.json({ success: true, real_phone: phone, customer_id: customerId, linked: !!customerId });
});

router.post('/conversations/:id/reopen', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  await pg.query(`UPDATE crm_conversations SET status = 'active', updated_at = now() WHERE id = $1`, [id]);
  notify.notifyConvUpdated(id);
  res.json({ success: true });
});

router.post('/conversations/:id/shadow', async (req, res) => {
  const id = parseInt(req.params.id);
  const enabled = !!req.body?.enabled;
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  await pg.query(`UPDATE crm_conversations SET shadow_mode = $2, updated_at = now() WHERE id = $1`, [id, enabled]);
  res.json({ success: true, shadow_mode: enabled });
});

// Detailed handover view — facts + last 7 turns + escalation class
router.get('/handovers/:id/detail', async (req, res) => {
  const id = parseInt(req.params.id);
  const ho = await pg.query(
    `SELECT h.*, c.phone, c.real_phone, c.customer_id
     FROM crm_handovers h JOIN crm_conversations c ON c.id = h.conversation_id
     WHERE h.id = $1`, [id]
  );
  if (!ho.rows[0]) return res.status(404).json({ success: false, message: 'not found' });
  const h = ho.rows[0];
  const [turns, facts] = await Promise.all([
    pg.query(
      `SELECT direction, sender_type, body, created_at FROM crm_messages
       WHERE conversation_id = $1 ORDER BY id DESC LIMIT 7`,
      [h.conversation_id]
    ),
    pg.query(
      `SELECT fact_key, fact_value FROM crm_customer_facts
       WHERE conversation_id = $1 OR customer_id = $2
       ORDER BY created_at DESC LIMIT 12`,
      [h.conversation_id, h.customer_id]
    ),
  ]);
  res.json({
    success: true,
    handover: {
      id: h.id, reason: h.reason, brief: h.brief, detail: h.detail,
      escalation_class: h.escalation_class, created_at: h.created_at,
      conversation_id: h.conversation_id,
    },
    turns: turns.rows.reverse(),
    facts: facts.rows,
  });
});

router.get('/handovers', async (req, res) => {
  const onlyOpen = req.query.open !== 'false';
  const sql = `
    SELECT h.id, h.conversation_id, h.message_id, h.reason, h.detail, h.brief, h.created_at,
           h.resolved_at, h.resolved_by, c.phone, c.customer_id
    FROM crm_handovers h
    JOIN crm_conversations c ON c.id = h.conversation_id
    ${onlyOpen ? 'WHERE h.resolved_at IS NULL' : ''}
    ORDER BY h.created_at DESC LIMIT 200`;
  const { rows } = await pg.query(sql);
  res.json({ success: true, items: rows });
});

// Customer profile + recent orders (read-only enrichment for the chat panel)
router.get('/conversations/:id/customer', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  const { rows } = await pg.query(
    `SELECT id, phone, real_phone, push_name, customer_id, last_message_at, last_intent,
            handover_count, status, shadow_mode, wa_session,
            pipeline_stage, pipeline_type, deal_value_idr, deal_value_locked,
            manual_stage_override, lost_reason
     FROM crm_conversations WHERE id = $1`, [id]
  );
  const conv = rows[0];
  if (!conv) return res.status(404).json({ success: false, message: 'not found' });

  const isLid = String(conv.phone).endsWith('@lid');
  const lookupPhone = conv.real_phone || (isLid ? null : conv.phone);

  // Auto-resolve customer_id from real_phone if not set yet
  if (!conv.customer_id && lookupPhone) {
    try {
      const r = await resolveByPhone(lookupPhone);
      if (r.customer_id) {
        await pg.query(`UPDATE crm_conversations SET customer_id = $2 WHERE id = $1`, [id, r.customer_id]);
        conv.customer_id = r.customer_id;
      }
    } catch {}
  }

  const profile = {
    phone: conv.phone, real_phone: conv.real_phone || null,
    push_name: conv.push_name, is_lid: isLid,
    customer_id: conv.customer_id, name: null,
    email: null, total_orders: 0, total_spent: 0, recent_orders: [],
  };

  if (conv.customer_id) {
    try {
      const mysql = require('../db/mysql');
      const [crows] = await mysql.query(
        `SELECT id, name, email, phone FROM customer WHERE id = ? LIMIT 1`,
        [conv.customer_id]
      );
      if (crows[0]) {
        profile.name = crows[0].name;
        profile.email = crows[0].email;
      }
      const [stats] = await mysql.query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS spent,
                COALESCE(AVG(total), 0) AS aov, MAX(created_at) AS last_order_at
         FROM \`order\` WHERE customer_id = ? AND deleted_at IS NULL`,
        [conv.customer_id]
      );
      profile.total_orders = Number(stats[0]?.n || 0);
      profile.total_spent = Number(stats[0]?.spent || 0);
      profile.aov = Math.round(Number(stats[0]?.aov || 0));
      profile.last_order_at = stats[0]?.last_order_at || null;
      // Recency bucket
      if (profile.last_order_at) {
        const days = Math.floor((Date.now() - new Date(profile.last_order_at).getTime()) / 86400000);
        profile.days_since_last_order = days;
        profile.recency_bucket =
          days <= 30  ? 'active'
          : days <= 90 ? 'dormant'
          : 'churned';
      }

      const [recent] = await mysql.query(
        `SELECT id, order_number, status, payment_status, total, created_at
         FROM \`order\` WHERE customer_id = ? AND deleted_at IS NULL
         ORDER BY id DESC LIMIT 5`,
        [conv.customer_id]
      );
      profile.recent_orders = recent;

      // Recipient address book (top 6 by frequency)
      const [recipients] = await mysql.query(
        `SELECT oi.receiver_name AS name, g.name AS city,
                COUNT(*) AS times, MAX(oi.date_time) AS last_at
         FROM order_items oi
         JOIN \`order\` o ON o.id = oi.order_id
         LEFT JOIN geo g ON g.id = oi.city
         WHERE o.customer_id = ? AND o.deleted_at IS NULL AND oi.deleted_at IS NULL
           AND oi.receiver_name IS NOT NULL AND oi.receiver_name != ''
         GROUP BY oi.receiver_name, g.name
         ORDER BY times DESC, last_at DESC LIMIT 6`,
        [conv.customer_id]
      );
      profile.recipients = recipients;

      // Customer health score
      try {
        const h = await pg.query(
          `SELECT score, band, computed_at FROM crm_customer_health WHERE customer_id = $1`,
          [conv.customer_id]
        );
        if (h.rows[0]) profile.health = h.rows[0];
      } catch {}

      // Customer facts
      try {
        const f = await pg.query(
          `SELECT fact_key, fact_value, created_at FROM crm_customer_facts
           WHERE conversation_id = $1 OR customer_id = $2
           ORDER BY created_at DESC LIMIT 30`,
          [conv.id, conv.customer_id]
        );
        const dedup = {};
        for (const row of f.rows) if (!dedup[row.fact_key]) dedup[row.fact_key] = row;
        profile.facts = Object.values(dedup);
      } catch {}

      // Top product categories
      const [categories] = await mysql.query(
        `SELECT COALESCE(c.name, '?') AS category,
                COUNT(*) AS times,
                COALESCE(SUM(oi.subtotal), 0) AS total
         FROM order_items oi
         JOIN \`order\` o ON o.id = oi.order_id
         LEFT JOIN products p ON p.id = oi.product_id
         LEFT JOIN product_category_new c ON c.id = p.category_id
         WHERE o.customer_id = ? AND o.deleted_at IS NULL AND oi.deleted_at IS NULL
         GROUP BY category ORDER BY times DESC LIMIT 5`,
        [conv.customer_id]
      );
      profile.top_categories = categories;
    } catch (err) {
      logger.warn({ err: err.message, convId: id }, '[inbox.customer] mysql lookup failed');
    }
  }

  res.json({
    success: true,
    conversation: {
      id: conv.id, last_intent: conv.last_intent,
      handover_count: conv.handover_count, status: conv.status,
      shadow_mode: conv.shadow_mode, wa_session: conv.wa_session,
    },
    profile,
  });
});

// #5 Inline AI rewriter — operator drafts reply, AI refine tone & clarity
router.post('/conversations/:id/rewrite', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  const draft = (req.body?.draft || '').toString().trim();
  const tone = req.body?.tone || 'sopan'; // sopan | formal | santai | empathic
  if (!draft) return res.status(400).json({ success: false, message: 'draft required' });

  const ctx = await loadConvContext(id, 6);
  if (!ctx) return res.status(404).json({ success: false, message: 'conv not found' });
  const transcript = (ctx.messages || []).slice(-6).map((m) =>
    `${m.direction === 'in' ? 'Customer' : 'Op'}: ${(m.body || '').slice(0, 200)}`
  ).join('\n');

  const prompt = `Sebagai asisten CS Prestisa (toko bunga online), perbaiki draft reply operator berikut. Pertahankan inti pesan, perhalus tone (${tone}), perbaiki tata bahasa Indonesia, tambahkan sapaan/penutup yang natural. JANGAN tambah informasi baru/janji yang tidak ada di draft. Output cuma teks reply yang sudah diperbaiki, tanpa preamble.

=== KONTEKS PERCAKAPAN ===
${transcript}
=== DRAFT OPERATOR ===
${draft}
=== END ===`;

  try {
    const result = await aiClient.generateWithTools({
      systemPrompt: 'Kamu copy editor bahasa Indonesia. Output: hanya teks reply yang sudah diperbaiki, tanpa quote/tanda kutip/preamble.',
      messages: [{ role: 'user', content: prompt }],
      tools: [], executor: async () => ({ unsupported: true }), maxIterations: 1,
    });
    res.json({ success: true, rewritten: (result.text || '').trim() });
  } catch (err) {
    res.status(502).json({ success: false, message: err.message });
  }
});

// #8 Snooze conversation — operator parks for X hours
// Catalog product search — operator picker in chat composer
router.get('/products/search', async (req, res) => {
  const mysql = require('../db/mysql');
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.min(parseInt(req.query.limit) || 12, 50);
  const where = ['p.deleted_at IS NULL', 'p.active = 1'];
  const params = [];
  if (q) {
    for (const t of q.split(/\s+/).filter(Boolean).slice(0, 5)) {
      params.push(`%${t}%`, `%${t}%`);
      where.push('(LOWER(p.name) LIKE ? OR LOWER(c.name) LIKE ?)');
    }
  }
  try {
    const [rows] = await mysql.query(
      `SELECT p.id, p.name, p.price, p.image AS image_url, COALESCE(c.name,'?') AS category
       FROM products p
       LEFT JOIN product_category_new c ON c.id = p.category_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.id DESC LIMIT ${limit}`,
      params
    );
    res.json({ success: true, items: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Send product card (image + caption) — operator-driven
router.post('/conversations/:id/send-product', async (req, res) => {
  const id = parseInt(req.params.id);
  const productId = parseInt(req.body?.product_id);
  if (!id || !productId) return res.status(400).json({ success: false, message: 'id + product_id required' });
  const mysql = require('../db/mysql');
  const [rows] = await mysql.query(
    `SELECT id, name, price, image FROM products WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [productId]
  );
  const p = rows[0];
  if (!p) return res.status(404).json({ success: false, message: 'product not found' });
  const conv = await pg.query(`SELECT phone, wa_session FROM crm_conversations WHERE id = $1`, [id]);
  if (!conv.rows[0]) return res.status(404).json({ success: false, message: 'conv not found' });
  const caption = `🌷 ${p.name}\nHarga: Rp ${Number(p.price).toLocaleString('id-ID')}\n\nMau dipilih ini Kak?`;
  const wa = require('../services/waClient');
  try {
    const sent = await wa.sendImage({
      phone: conv.rows[0].phone, imageUrl: p.image, caption,
      session: conv.rows[0].wa_session,
    });
    await pg.query(
      `INSERT INTO crm_messages (conversation_id, direction, sender_type, staff_id, body, message_type, attachment_url, send_status, waha_message_id, ai_metadata)
       VALUES ($1, 'out', 'staff', $2, $3, 'image', $4, 'sent', $5, $6)`,
      [id, req.staff.staff_id, caption, p.image, sent?.id || null, JSON.stringify({ product_id: p.id, source: 'catalog_picker' })]
    );
    notify.notifyMessage({ conversation_id: id, message: { conversation_id: id, body: caption, direction: 'out', sender_type: 'staff', message_type: 'image', attachment_url: p.image } });
    res.json({ success: true, product: p });
  } catch (err) {
    res.status(502).json({ success: false, message: err.message });
  }
});

router.post('/conversations/:id/snooze', async (req, res) => {
  const id = parseInt(req.params.id);
  const hours = parseInt(req.body?.hours);
  const note = (req.body?.note || '').toString().slice(0, 500) || null;
  if (!id || !hours || hours < 1 || hours > 720) {
    return res.status(400).json({ success: false, message: 'hours 1-720 required' });
  }
  await pg.query(
    `UPDATE crm_conversations
       SET snoozed_until = now() + ($2 || ' hours')::interval,
           snoozed_by = $3, snoozed_note = $4, updated_at = now()
     WHERE id = $1`,
    [id, String(hours), req.staff.staff_id, note]
  );
  notify.notifyConvUpdated(id);
  res.json({ success: true });
});
router.post('/conversations/:id/unsnooze', async (req, res) => {
  const id = parseInt(req.params.id);
  await pg.query(
    `UPDATE crm_conversations SET snoozed_until = NULL, snoozed_by = NULL, snoozed_note = NULL WHERE id = $1`,
    [id]
  );
  notify.notifyConvUpdated(id);
  res.json({ success: true });
});

// Pull WhatsApp contact info (display name, profile pic, business flag) from
// WAHA on demand. Operator clicks "Pull WA contact" in the customer panel.
router.get('/conversations/:id/wa-contact', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  const { rows } = await pg.query(
    `SELECT phone, wa_session FROM crm_conversations WHERE id = $1`, [id]
  );
  const conv = rows[0];
  if (!conv) return res.status(404).json({ success: false, message: 'not found' });
  try {
    const info = await waClient.getContact({ phone: conv.phone, session: conv.wa_session });
    // Persist push_name if WAHA returned a better one and we don't have it stored
    if (info.push_name || info.name) {
      const pushName = info.push_name || info.name;
      await pg.query(
        `UPDATE crm_conversations SET push_name = COALESCE(push_name, $2) WHERE id = $1`,
        [id, pushName]
      );
    }
    res.json({ success: true, info });
  } catch (err) {
    res.status(502).json({ success: false, message: err.message });
  }
});

// ── AI helpers untuk operator (suggest reply + summary) ────────────────────

async function loadConvContext(convId, historyLimit = 30) {
  const c = await pg.query(`SELECT * FROM crm_conversations WHERE id = $1`, [convId]);
  if (!c.rows[0]) return null;
  const m = await pg.query(
    `SELECT direction, sender_type, body, message_type, created_at
     FROM crm_messages WHERE conversation_id = $1
     ORDER BY id DESC LIMIT $2`,
    [convId, historyLimit]
  );
  return { conv: c.rows[0], messages: m.rows.reverse() };
}

router.post('/conversations/:id/ai-suggest-reply', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  const ctx = await loadConvContext(id);
  if (!ctx) return res.status(404).json({ success: false, message: 'conversation not found' });
  if (!ctx.messages.length) return res.status(400).json({ success: false, message: 'belum ada pesan' });

  const resolved = await resolveByPhone(ctx.conv.phone);
  // Slightly different system prompt: AI suggests for OPERATOR to send (not autonomous)
  const baseSystem = await persona.buildSystemPrompt({
    conv: ctx.conv, customerName: resolved.name, cityHint: null,
  });
  const systemPrompt = `${baseSystem}

=== MODE: OPERATOR ASSIST ===
Saat ini operator manusia yang sedang handle chat ini. Tugasmu:
- Saran 1 balasan SINGKAT (1-3 kalimat) untuk dikirim operator ke customer.
- Pakai tools dulu kalau perlu data (search_products, track_order, dll).
- Output HANYA teks balasan akhir — operator akan baca, edit (kalau perlu), lalu kirim.
- JANGAN pakai tool request_handover di sini (kita SUDAH di-handover).
- JANGAN sapa "Halo Kak" lagi kalau di history sudah ada sapaan; lanjutkan natural.`;

  const messages = persona.buildHistoryMessages(ctx.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: '(Operator minta saran balasan untuk pesan terakhir customer)' });
  }

  const exec = (name, args) => {
    if (name === 'request_handover') {
      return Promise.resolve({ ok: false, error: 'request_handover blocked in operator-assist mode' });
    }
    const fn = tools.executors[name];
    if (!fn) return Promise.resolve({ error: `unknown tool ${name}` });
    return Promise.resolve(fn({ args, conv: ctx.conv, customer_id: ctx.conv.customer_id, phone: ctx.conv.phone }));
  };

  try {
    const llm = await aiClient.generateWithTools({
      systemPrompt, messages, tools: tools.declarations, executor: exec, maxIterations: 4,
    });
    res.json({
      success: true,
      reply: (llm.text || '').trim(),
      tools_used: llm.calls.map((c) => ({ name: c.name, args: c.args, error: c.error || null })),
      usage: llm.usage,
    });
  } catch (err) {
    logger.error({ err: err.message, convId: id }, '[ai-suggest-reply] failed');
    res.status(502).json({ success: false, message: err.message });
  }
});

router.post('/conversations/:id/ai-summary', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  const ctx = await loadConvContext(id, 60);
  if (!ctx) return res.status(404).json({ success: false, message: 'conversation not found' });
  if (!ctx.messages.length) return res.status(400).json({ success: false, message: 'belum ada pesan' });

  const transcript = ctx.messages
    .map((m) => {
      const who = m.sender_type === 'customer' ? 'Customer'
        : m.sender_type === 'staff' ? 'Operator'
        : 'Tiara';
      return `${who}: ${(m.body || `[${m.message_type || 'attachment'}]`).slice(0, 300)}`;
    })
    .join('\n');

  const systemPrompt = `Kamu asisten yang bantu operator CS Prestisa cepat catch-up percakapan WhatsApp.`;
  const messages = [{
    role: 'user',
    content: `Ringkas percakapan berikut dalam Bahasa Indonesia. Format:

**Ringkasan:** 2-3 kalimat tentang situasinya.
**Kebutuhan customer:** apa yang dia minta / butuhkan.
**Status:** sudah diselesaikan / butuh tindakan operator / menunggu customer.
**Action item:** kalau ada, list 1-3 hal yang perlu operator lakukan selanjutnya.

Transkrip (${ctx.messages.length} pesan):
${transcript}`,
  }];

  try {
    const llm = await aiClient.generateWithTools({
      systemPrompt, messages, tools: [], executor: () => ({}), maxIterations: 1,
    });
    res.json({
      success: true,
      summary: (llm.text || '').trim(),
      message_count: ctx.messages.length,
      usage: llm.usage,
    });
  } catch (err) {
    logger.error({ err: err.message, convId: id }, '[ai-summary] failed');
    res.status(502).json({ success: false, message: err.message });
  }
});

// Self-assign or unassign a conversation (queue management)
router.post('/conversations/:id/assign', async (req, res) => {
  const id = parseInt(req.params.id);
  const target = req.body?.staff_id;
  let assignedTo = null;
  if (target === 'me' || target === undefined) assignedTo = req.staff.staff_id;
  else if (target === null) assignedTo = null;
  else assignedTo = parseInt(target) || null;
  await pg.query(
    `UPDATE crm_conversations SET assigned_staff_id = $2, updated_at = now() WHERE id = $1`,
    [id, assignedTo]
  );
  notify.notifyConvUpdated(id);
  res.json({ success: true, assigned_staff_id: assignedTo });
});

// ── CSAT collection ─────────────────────────────────────────────────────────
// Send CSAT prompt to customer (manual trigger from chat UI)
router.post('/conversations/:id/csat-request', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  const { rows } = await pg.query(
    `SELECT id, phone, wa_session FROM crm_conversations WHERE id = $1`, [id]
  );
  const conv = rows[0];
  if (!conv) return res.status(404).json({ success: false, message: 'conv not found' });

  const body = `Halo Kak 🙏 Boleh kasih rating pengalaman chat tadi? Balas angka 1-5 ya:\n5 ⭐⭐⭐⭐⭐ Sangat puas\n4 ⭐⭐⭐⭐ Puas\n3 ⭐⭐⭐ Biasa\n2 ⭐⭐ Kurang\n1 ⭐ Tidak puas`;
  try {
    const sent = await waClient.sendText({ phone: conv.phone, text: body, session: conv.wa_session });
    await pg.query(
      `INSERT INTO crm_messages (conversation_id, direction, sender_type, body, message_type, send_status, waha_message_id)
       VALUES ($1, 'out', 'system', $2, 'text', 'sent', $3)`,
      [id, body, sent?.id || null]
    );
    notify.notifyConvUpdated(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// List recent CSAT scores (for monitor dashboard)
router.get('/csat/recent', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const { rows } = await pg.query(
    `SELECT cs.id, cs.conversation_id, cs.score, cs.comment, cs.collected_at, c.phone
     FROM crm_csat cs JOIN crm_conversations c ON c.id = cs.conversation_id
     ORDER BY cs.collected_at DESC LIMIT $1`, [limit]
  );
  const stats = await pg.query(
    `SELECT AVG(score)::numeric(3,2) AS avg, COUNT(*) AS total,
            SUM(CASE WHEN score >= 4 THEN 1 ELSE 0 END) AS satisfied,
            SUM(CASE WHEN score <= 2 THEN 1 ELSE 0 END) AS unsatisfied
     FROM crm_csat WHERE collected_at > now() - interval '30 days'`
  );
  res.json({ success: true, items: rows, stats_30d: stats.rows[0] });
});

// ── Bulk + queue filters ────────────────────────────────────────────────────
router.post('/conversations/bulk', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((n) => parseInt(n)).filter(Boolean) : [];
  const action = req.body?.action;
  const tagId = parseInt(req.body?.tag_id) || null;
  if (!ids.length || !action) return res.status(400).json({ success: false, message: 'ids and action required' });
  if (!['close', 'reopen', 'tag', 'untag', 'shadow_on', 'shadow_off'].includes(action)) {
    return res.status(400).json({ success: false, message: 'unknown action' });
  }
  let affected = 0;
  if (action === 'close') {
    const r = await pg.query(`UPDATE crm_conversations SET status='closed', updated_at=now() WHERE id = ANY($1::int[])`, [ids]);
    affected = r.rowCount;
  } else if (action === 'reopen') {
    const r = await pg.query(`UPDATE crm_conversations SET status='active', updated_at=now() WHERE id = ANY($1::int[])`, [ids]);
    affected = r.rowCount;
  } else if (action === 'shadow_on' || action === 'shadow_off') {
    const r = await pg.query(`UPDATE crm_conversations SET shadow_mode=$2, updated_at=now() WHERE id = ANY($1::int[])`, [ids, action === 'shadow_on']);
    affected = r.rowCount;
  } else if (action === 'tag' && tagId) {
    for (const id of ids) {
      await pg.query(`INSERT INTO crm_conversation_tags (conversation_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, tagId]);
      affected++;
    }
  } else if (action === 'untag' && tagId) {
    const r = await pg.query(`DELETE FROM crm_conversation_tags WHERE tag_id=$2 AND conversation_id = ANY($1::int[])`, [ids, tagId]);
    affected = r.rowCount;
  }
  ids.forEach((id) => notify.notifyConvUpdated(id));
  res.json({ success: true, affected });
});

router.post('/handovers/:id/resolve', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  await pg.query(
    `UPDATE crm_handovers SET resolved_at = now(), resolved_by = $2 WHERE id = $1`,
    [id, req.staff.staff_id]
  );
  // Pipeline: refund/cancel handover resolved → lost
  try {
    const ho = await pg.query(`SELECT conversation_id, reason FROM crm_handovers WHERE id = $1`, [id]);
    const reason = ho.rows[0]?.reason;
    const convId = ho.rows[0]?.conversation_id;
    if (convId && (reason === 'refund' || reason === 'cancel')) {
      const engine = require('../services/pipelineEngine');
      await engine.apply(pg, convId, {
        type: reason === 'refund' ? 'handover_refund' : 'handover_cancel',
      }, {
        source: 'auto:handover_resolved',
        staffId: req.staff.staff_id,
        lostReason: reason === 'refund' ? 'refund_complaint' : 'cancelled',
      });
    }
  } catch (err) {
    console.warn('[pipeline] handover resolve hook failed:', err.message);
  }
  res.json({ success: true });
});

// ── Internal comments per conv (operator collaboration with @mention) ──
router.get('/conversations/:id/comments', async (req, res) => {
  const id = parseInt(req.params.id);
  const { rows } = await pg.query(
    `SELECT c.id, c.body, c.mentions, c.created_at, c.staff_id,
            u.username, u.full_name
     FROM crm_internal_comments c
     LEFT JOIN staff_users u ON u.id = c.staff_id
     WHERE c.conversation_id = $1 ORDER BY c.id ASC LIMIT 200`,
    [id]
  );
  res.json({ success: true, items: rows });
});

router.post('/conversations/:id/comments', async (req, res) => {
  const id = parseInt(req.params.id);
  const body = (req.body?.body || '').toString().trim();
  if (!body) return res.status(400).json({ success: false, message: 'body required' });
  if (body.length > 4000) return res.status(400).json({ success: false, message: 'body max 4000 chars' });

  const mentionParser = require('../services/mentionParser');
  // Re-validate server-side regardless of client-supplied mentions
  const mentions = await mentionParser.parse(pg, body);

  const { rows } = await pg.query(
    `INSERT INTO crm_internal_comments (conversation_id, staff_id, body, mentions)
     VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
    [id, req.staff.staff_id, body, mentions]
  );

  // Notify mentioned users (skip self)
  try {
    const notif = require('../services/notificationsService');
    const conv = await pg.query(`SELECT phone, push_name FROM crm_conversations WHERE id = $1`, [id]);
    const phone = conv.rows[0]?.push_name || conv.rows[0]?.phone || `#${id}`;
    for (const targetId of mentions) {
      if (targetId === req.staff.staff_id) continue;
      await notif.notify(targetId, 'mention', `${req.staff.username} mention kamu di ${phone}`,
        { body: body.slice(0, 200), link: `/inbox/${id}`, payload: { conv_id: id, comment_id: rows[0].id } });
    }
  } catch {}

  res.json({ success: true, id: rows[0].id, mentions });
});

// ── Bulk actions (extended) ────────────────────────────────────────────────
async function processBulk(ids, fn) {
  let ok = 0, failed = 0;
  const errors = [];
  for (const id of ids) {
    try {
      await fn(id);
      ok++;
    } catch (err) {
      failed++;
      errors.push({ conv_id: id, message: err.message });
    }
  }
  return { ok, failed, errors };
}

router.post('/bulk-assign', async (req, res) => {
  const ids = (req.body?.conv_ids || []).map((n) => parseInt(n)).filter(Boolean);
  const staffId = req.body?.staff_id ? parseInt(req.body.staff_id) : null;
  if (!ids.length) return res.status(400).json({ success: false, message: 'conv_ids required' });
  const r = await processBulk(ids, async (id) => {
    await pg.query(`UPDATE crm_conversations SET assigned_staff_id = $2, updated_at = now() WHERE id = $1`, [id, staffId]);
    notify.notifyConvUpdated(id);
  });
  res.json({ success: true, ...r });
});

router.post('/bulk-snooze', async (req, res) => {
  const ids = (req.body?.conv_ids || []).map((n) => parseInt(n)).filter(Boolean);
  const hours = parseInt(req.body?.hours);
  if (!ids.length || !hours || hours < 1 || hours > 720) {
    return res.status(400).json({ success: false, message: 'conv_ids + hours 1-720 required' });
  }
  const r = await processBulk(ids, async (id) => {
    await pg.query(
      `UPDATE crm_conversations SET snoozed_until = now() + ($2 || ' hours')::interval,
         snoozed_by = $3, updated_at = now() WHERE id = $1`,
      [id, String(hours), req.staff.staff_id]
    );
    notify.notifyConvUpdated(id);
  });
  res.json({ success: true, ...r });
});

router.post('/bulk-close', async (req, res) => {
  const ids = (req.body?.conv_ids || []).map((n) => parseInt(n)).filter(Boolean);
  if (!ids.length) return res.status(400).json({ success: false, message: 'conv_ids required' });
  const r = await processBulk(ids, async (id) => {
    await pg.query(`UPDATE crm_conversations SET status = 'closed', updated_at = now() WHERE id = $1`, [id]);
    notify.notifyConvUpdated(id);
  });
  res.json({ success: true, ...r });
});

router.post('/bulk-tag', async (req, res) => {
  const ids = (req.body?.conv_ids || []).map((n) => parseInt(n)).filter(Boolean);
  const tagId = parseInt(req.body?.tag_id);
  const action = req.body?.action;
  if (!ids.length || !tagId || !['add', 'remove'].includes(action)) {
    return res.status(400).json({ success: false, message: 'conv_ids + tag_id + action(add|remove) required' });
  }
  const r = await processBulk(ids, async (id) => {
    if (action === 'add') {
      await pg.query(
        `INSERT INTO crm_conversation_tags (conversation_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, tagId]
      );
    } else {
      await pg.query(`DELETE FROM crm_conversation_tags WHERE conversation_id = $1 AND tag_id = $2`, [id, tagId]);
    }
  });
  res.json({ success: true, ...r });
});

module.exports = router;
