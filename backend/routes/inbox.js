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
    )
    SELECT conv.id, conv.phone, conv.customer_id, conv.status, conv.ai_enabled,
           conv.ai_paused_until, conv.assigned_staff_id, conv.last_message_at,
           conv.last_intent, conv.handover_count, conv.shadow_mode, conv.wa_session,
           lm.body AS last_body, lm.sender_type AS last_sender, lm.created_at AS last_at,
           COALESCE(ho.n, 0) AS open_handovers
    FROM crm_conversations conv
    LEFT JOIN last_msg lm ON lm.conversation_id = conv.id
    LEFT JOIN handover_open ho ON ho.conversation_id = conv.id
    ${whereSql}
    ORDER BY COALESCE(conv.last_message_at, conv.updated_at) DESC
    LIMIT 200`;
  const { rows } = await pg.query(sql, params);
  const items = search
    ? rows.filter((r) => (r.phone || '').includes(search))
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
    `SELECT id, direction, sender_type, staff_id, body, message_type, attachment_url,
            ai_metadata, shadow, send_status, created_at
     FROM crm_messages WHERE conversation_id = $1
     ORDER BY id ASC LIMIT 500`,
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

router.get('/handovers', async (req, res) => {
  const onlyOpen = req.query.open !== 'false';
  const sql = `
    SELECT h.id, h.conversation_id, h.message_id, h.reason, h.detail, h.created_at,
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
    `SELECT id, phone, customer_id, last_message_at, last_intent,
            handover_count, status, shadow_mode, wa_session
     FROM crm_conversations WHERE id = $1`, [id]
  );
  const conv = rows[0];
  if (!conv) return res.status(404).json({ success: false, message: 'not found' });

  const profile = { phone: conv.phone, customer_id: conv.customer_id, name: null,
    email: null, total_orders: 0, total_spent: 0, recent_orders: [] };

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
        `SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS spent
         FROM \`order\` WHERE customer_id = ? AND deleted_at IS NULL`,
        [conv.customer_id]
      );
      profile.total_orders = Number(stats[0]?.n || 0);
      profile.total_spent = Number(stats[0]?.spent || 0);
      const [recent] = await mysql.query(
        `SELECT id, order_number, status, payment_status, total, created_at
         FROM \`order\` WHERE customer_id = ? AND deleted_at IS NULL
         ORDER BY id DESC LIMIT 5`,
        [conv.customer_id]
      );
      profile.recent_orders = recent;
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

router.post('/handovers/:id/resolve', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  await pg.query(
    `UPDATE crm_handovers SET resolved_at = now(), resolved_by = $2 WHERE id = $1`,
    [id, req.staff.staff_id]
  );
  res.json({ success: true });
});

module.exports = router;
