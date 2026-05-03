// backend/routes/leadDist.js
// Admin endpoints for lead distribution config + manual assignment.
const express = require('express');
const pg = require('../db/postgres');
const settings = require('../services/settings');
const leadDist = require('../services/leadDistributor');
const { requireStaff } = require('../middleware/auth');

const router = express.Router();
router.use(requireStaff);
router.use((req, res, next) => {
  if (req.staff?.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  next();
});

// GET /config — current mode + per-role staff list with load
router.get('/config', async (_req, res) => {
  const mode = await settings.getSetting('lead_distribution_mode', 'auto');
  const staff = await pg.query(
    `SELECT u.id, u.username, u.full_name, u.role, u.active,
            COUNT(c.id) FILTER (WHERE c.status = 'active' AND c.assigned_staff_id = u.id)::int AS open_convs
     FROM staff_users u
     LEFT JOIN crm_conversations c ON c.assigned_staff_id = u.id
     WHERE u.active = TRUE AND u.role IN ('acquisition', 'retention', 'operator', 'admin', 'staff')
     GROUP BY u.id, u.username, u.full_name, u.role, u.active
     ORDER BY u.role, u.username`
  );
  res.json({ mode, staff: staff.rows });
});

// PUT /config — set mode (auto | manual)
router.put('/config', async (req, res) => {
  const mode = req.body?.mode;
  if (!['auto', 'manual'].includes(mode)) return res.status(400).json({ error: 'mode must be auto|manual' });
  await pg.query(
    `INSERT INTO crm_settings (key, value) VALUES ('lead_distribution_mode', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(mode)]
  );
  // Bust settings cache so new mode takes effect immediately
  try { settings.invalidateCache(); } catch {}
  res.json({ ok: true, mode });
});

// GET /stats — today's distribution counts per role + recent assignments
router.get('/stats', async (_req, res) => {
  const counts = await pg.query(
    `SELECT role, source, COUNT(*)::int AS n
     FROM crm_lead_assignments
     WHERE assigned_at >= current_date
     GROUP BY role, source ORDER BY role, source`
  );
  const recent = await pg.query(
    `SELECT a.id, a.conversation_id, a.staff_id, a.role, a.source, a.customer_state, a.assigned_at,
            u.username, c.phone
     FROM crm_lead_assignments a
     LEFT JOIN staff_users u ON u.id = a.staff_id
     LEFT JOIN crm_conversations c ON c.id = a.conversation_id
     ORDER BY a.id DESC LIMIT 30`
  );
  res.json({ counts: counts.rows, recent: recent.rows });
});

// GET /unassigned — convs awaiting assignment (manual mode or no eligible staff)
router.get('/unassigned', async (_req, res) => {
  const r = await pg.query(
    `SELECT c.id, c.phone, c.real_phone, c.push_name, c.last_message_at, c.customer_id,
            c.lead_temperature, c.last_intent
     FROM crm_conversations c
     WHERE c.status = 'active' AND c.assigned_staff_id IS NULL
       AND c.last_message_at > now() - interval '7 days'
     ORDER BY c.last_message_at DESC LIMIT 100`
  );
  res.json({ items: r.rows });
});

// POST /assign — manual assignment
router.post('/assign', async (req, res) => {
  const convId = parseInt(req.body?.conversation_id);
  const staffId = parseInt(req.body?.staff_id);
  if (!Number.isFinite(convId) || !Number.isFinite(staffId)) return res.status(400).json({ error: 'bad_ids' });
  const r = await leadDist.manualAssign(convId, staffId, req.staff.staff_id);
  res.json(r);
});

module.exports = router;
