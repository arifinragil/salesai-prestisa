// User management — admin only. CRUD on staff_users + heartbeat presence + claims.
const express = require('express');
const pg = require('../db/postgres');
const { requireStaff, AUTHENTIK_GROUP_ROLE_MAP, DEFAULT_ROLE_FROM_AUTHENTIK } = require('../middleware/auth');
const { hashPassword } = require('../services/password');
const settings = require('../services/settings');

const router = express.Router();
router.use(requireStaff);

// Valid CRM roles = admin + all Authentik-mapped roles + the default fallback.
// Derived so it auto-includes new roles (e.g. acquisition_manager) without edits.
const VALID_ROLES = [...new Set(['admin', ...AUTHENTIK_GROUP_ROLE_MAP.map(([, r]) => r), DEFAULT_ROLE_FROM_AUTHENTIK])];

function requireAdmin(req, res, next) {
  if (req.staff?.role !== 'admin') return res.status(403).json({ success: false, message: 'admin only' });
  next();
}

// Heartbeat — any logged-in staff. Updates last_seen_at.
router.post('/me/heartbeat', async (req, res) => {
  await pg.query(`UPDATE staff_users SET last_seen_at = now() WHERE id = $1`, [req.staff.staff_id]);
  res.json({ success: true });
});

// Active staff list — used by mention autocomplete (cached client-side).
router.get('/active', async (_req, res) => {
  const { rows } = await pg.query(
    `SELECT id, username, full_name FROM staff_users
     WHERE active = TRUE AND disabled_at IS NULL ORDER BY username LIMIT 100`
  );
  res.json({ success: true, items: rows });
});

// Update own telegram_chat_id (opt-in personal notifications).
router.put('/me/telegram', async (req, res) => {
  const chatId = (req.body?.telegram_chat_id || '').toString().trim() || null;
  await pg.query(`UPDATE staff_users SET telegram_chat_id = $2 WHERE id = $1`, [req.staff.staff_id, chatId]);
  res.json({ success: true });
});

// Test personal Telegram delivery.
router.post('/me/telegram-test', async (req, res) => {
  const tg = require('../services/telegramNotify');
  const r = await tg.sendToStaff(req.staff.staff_id,
    `✅ Halo ${req.staff.username}! Channel personal Tiara CRM aktif. Notifikasi task & mention akan masuk ke sini.`);
  if (!r.ok) return res.status(400).json({ success: false, message: r.skipped || r.error || 'send failed' });
  res.json({ success: true });
});

// Get own profile (for telegram_chat_id form).
router.get('/me', async (req, res) => {
  const { rows } = await pg.query(
    `SELECT id, username, full_name, role, telegram_chat_id FROM staff_users WHERE id = $1`,
    [req.staff.staff_id]
  );
  res.json({ success: true, user: rows[0] });
});

// Online roster — anyone logged in can see who else is online (last 90s).
router.get('/online', async (_req, res) => {
  const { rows } = await pg.query(
    `SELECT id, username, full_name, role, last_seen_at
     FROM staff_users
     WHERE disabled_at IS NULL AND last_seen_at > now() - interval '90 seconds'
     ORDER BY full_name`
  );
  res.json({ success: true, items: rows });
});

router.get('/', requireAdmin, async (_req, res) => {
  const { rows } = await pg.query(
    `SELECT id, username, full_name, role, active, last_login_at, last_seen_at, disabled_at, created_at
     FROM staff_users ORDER BY id`
  );
  res.json({ success: true, items: rows });
});

router.post('/', requireAdmin, async (req, res) => {
  const { username, password, full_name, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false, message: 'username + password required' });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ success: false, message: 'role must be one of: ' + VALID_ROLES.join('|') });
  if (String(password).length < 6) return res.status(400).json({ success: false, message: 'password min 6 chars' });
  const hash = await hashPassword(String(password));
  try {
    const { rows } = await pg.query(
      `INSERT INTO staff_users (username, password_hash, full_name, role, active)
       VALUES ($1, $2, $3, $4, TRUE) RETURNING id, username, full_name, role, active`,
      [String(username).trim(), hash, full_name || username, role]
    );
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    if (String(err.message).includes('duplicate')) {
      return res.status(409).json({ success: false, message: 'username sudah ada' });
    }
    throw err;
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  const { full_name, role, active } = req.body || {};
  if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ success: false, message: 'role must be one of: ' + VALID_ROLES.join('|') });
  await pg.query(
    `UPDATE staff_users SET
       full_name = COALESCE($2, full_name),
       role = COALESCE($3, role),
       active = COALESCE($4, active),
       disabled_at = CASE WHEN $4 = FALSE THEN now() ELSE disabled_at END
     WHERE id = $1`,
    [id, full_name ?? null, role ?? null, typeof active === 'boolean' ? active : null]
  );
  res.json({ success: true });
});

router.post('/:id/reset-password', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { password } = req.body || {};
  if (!password || String(password).length < 6) return res.status(400).json({ success: false, message: 'password min 6 chars' });
  const hash = await hashPassword(String(password));
  await pg.query(`UPDATE staff_users SET password_hash = $2 WHERE id = $1`, [id, hash]);
  res.json({ success: true });
});

// ── Conversation claims (lead distribution) ─────────────────────────────────
router.post('/conversations/:id/claim', async (req, res) => {
  const convId = parseInt(req.params.id);
  if (!convId) return res.status(400).json({ success: false, message: 'invalid id' });
  const leaseMin = parseInt(await settings.getSetting('claim_lease_minutes', 5)) || 5;

  // Try insert, if existing claim still valid by another staff → conflict; otherwise upsert.
  const existing = await pg.query(
    `SELECT staff_id, expires_at FROM crm_conversation_claims
     WHERE conversation_id = $1 AND released_at IS NULL AND expires_at > now()`,
    [convId]
  );
  if (existing.rows[0] && existing.rows[0].staff_id !== req.staff.staff_id) {
    const u = await pg.query(`SELECT username, full_name FROM staff_users WHERE id = $1`, [existing.rows[0].staff_id]);
    return res.status(409).json({
      success: false, message: 'sudah di-claim',
      claimed_by: u.rows[0]?.full_name || u.rows[0]?.username,
      expires_at: existing.rows[0].expires_at,
    });
  }
  await pg.query(
    `INSERT INTO crm_conversation_claims (conversation_id, staff_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval)
     ON CONFLICT (conversation_id) DO UPDATE
       SET staff_id = EXCLUDED.staff_id,
           claimed_at = now(),
           expires_at = EXCLUDED.expires_at,
           released_at = NULL`,
    [convId, req.staff.staff_id, String(leaseMin)]
  );
  // Pipeline: operator_claim event
  try {
    const engine = require('../services/pipelineEngine');
    await engine.apply(pg, convId, { type: 'operator_claim' }, {
      source: 'auto:operator_claim', staffId: req.staff.staff_id,
    });
  } catch (err) { console.warn('[pipeline] claim hook failed:', err.message); }
  res.json({ success: true, lease_minutes: leaseMin });
});

router.post('/conversations/:id/release', async (req, res) => {
  const convId = parseInt(req.params.id);
  const r = await pg.query(
    `UPDATE crm_conversation_claims
     SET released_at = now()
     WHERE conversation_id = $1 AND staff_id = $2 AND released_at IS NULL`,
    [convId, req.staff.staff_id]
  );
  res.json({ success: true, released: r.rowCount });
});

router.get('/conversations/:id/claim', async (req, res) => {
  const convId = parseInt(req.params.id);
  const { rows } = await pg.query(
    `SELECT cc.staff_id, cc.claimed_at, cc.expires_at, u.username, u.full_name
     FROM crm_conversation_claims cc
     JOIN staff_users u ON u.id = cc.staff_id
     WHERE cc.conversation_id = $1 AND cc.released_at IS NULL AND cc.expires_at > now()`,
    [convId]
  );
  res.json({ success: true, claim: rows[0] || null, me: req.staff.staff_id });
});

// ── Operator-private snippets ──────────────────────────────────────────────
router.get('/me/snippets', async (req, res) => {
  const { rows } = await pg.query(
    `SELECT id, shortcut, title, body FROM crm_operator_snippets
     WHERE staff_id = $1 ORDER BY shortcut`,
    [req.staff.staff_id]
  );
  res.json({ success: true, items: rows });
});

router.post('/me/snippets', async (req, res) => {
  const { shortcut, title, body } = req.body || {};
  if (!shortcut || !body) return res.status(400).json({ success: false, message: 'shortcut + body required' });
  try {
    const r = await pg.query(
      `INSERT INTO crm_operator_snippets (staff_id, shortcut, title, body)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (staff_id, shortcut) DO UPDATE SET title=EXCLUDED.title, body=EXCLUDED.body
       RETURNING id`,
      [req.staff.staff_id, String(shortcut).slice(0, 32), title || null, String(body)]
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/me/snippets/:id', async (req, res) => {
  await pg.query(`DELETE FROM crm_operator_snippets WHERE id = $1 AND staff_id = $2`,
    [parseInt(req.params.id), req.staff.staff_id]);
  res.json({ success: true });
});

// ── Shift schedules ─────────────────────────────────────────────────────────
router.get('/shifts', async (_req, res) => {
  const { rows } = await pg.query(
    `SELECT s.id, s.staff_id, s.weekday, s.start_time, s.end_time, s.active,
            u.username, u.full_name
     FROM crm_shifts s JOIN staff_users u ON u.id = s.staff_id
     ORDER BY s.weekday, s.start_time, u.username`
  );
  res.json({ success: true, items: rows });
});

router.post('/shifts', requireAdmin, async (req, res) => {
  const { staff_id, weekday, start_time, end_time, active } = req.body || {};
  if (!staff_id || weekday == null || !start_time || !end_time) {
    return res.status(400).json({ success: false, message: 'staff_id + weekday + start_time + end_time required' });
  }
  const { rows } = await pg.query(
    `INSERT INTO crm_shifts (staff_id, weekday, start_time, end_time, active)
     VALUES ($1, $2, $3, $4, COALESCE($5, TRUE)) RETURNING id`,
    [parseInt(staff_id), parseInt(weekday), start_time, end_time, active ?? true]
  );
  res.json({ success: true, id: rows[0].id });
});

router.delete('/shifts/:id', requireAdmin, async (req, res) => {
  await pg.query(`DELETE FROM crm_shifts WHERE id = $1`, [parseInt(req.params.id)]);
  res.json({ success: true });
});

router.get('/on-shift', async (_req, res) => {
  const shift = require('../services/shiftRouter');
  const ops = await shift.onShift();
  res.json({ success: true, items: ops });
});

module.exports = router;
