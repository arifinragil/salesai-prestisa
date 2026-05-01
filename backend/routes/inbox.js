const express = require('express');
const pg = require('../db/postgres');
const { requireStaff } = require('../middleware/auth');
const waClient = require('../services/waClient');
const notify = require('../services/notify');
const logger = require('../services/logger');

const router = express.Router();
router.use(requireStaff);

router.get('/conversations', async (req, res) => {
  const status = req.query.status;
  const search = (req.query.search || '').toString().trim().toLowerCase();
  const params = [];
  const where = [];
  if (status && ['active', 'closed', 'spam'].includes(status)) {
    params.push(status);
    where.push(`conv.status = $${params.length}`);
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
           conv.last_intent, conv.handover_count, conv.shadow_mode,
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
