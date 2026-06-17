// backend/routes/supervisorControl.js
// Supervisor Control — AI Diagnosis review + aksi supervisor. Admin-only.
const express = require('express');
const pg = require('../db/postgres');
const { requireStaff } = require('../middleware/auth');

const router = express.Router();
router.use(requireStaff);
router.use((req, res, next) => {
  if (req.staff?.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  next();
});

const VALID_ACTIONS = new Set(['ack', 'resolve', 'reassign', 'request_fu', 'revise_ai']);

// POST /lead/:lotus_id/action
router.post('/lead/:lotus_id/action', async (req, res, next) => {
  try {
    const { lotus_id } = req.params;
    const { action, note, corrected_root_cause, corrected_reason, final_status } = req.body || {};
    if (!VALID_ACTIONS.has(action)) return res.status(400).json({ error: 'bad_action' });

    const ins = await pg.query(
      `INSERT INTO crm_lead_supervisor_actions
         (lotus_id, staff_id, action, note, corrected_root_cause, corrected_reason, final_status)
       VALUES ($1, $2, $3, $4::text, $5::text, $6::text, $7::text)
       RETURNING id`,
      [lotus_id, req.staff.staff_id, action, note || null,
       corrected_root_cause || null, corrected_reason || null, final_status || null]
    );

    if (action === 'ack' || action === 'resolve') {
      await pg.query(
        `UPDATE crm_lotus_state SET supervisor_ack_at = now(), supervisor_ack_by = $2 WHERE lotus_id = $1`,
        [lotus_id, req.staff.staff_id]
      );
    }
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) { next(e); }
});

// GET /lead/:lotus_id/actions — histori aksi
router.get('/lead/:lotus_id/actions', async (req, res, next) => {
  try {
    const { rows } = await pg.query(
      `SELECT id, action, note, corrected_root_cause, corrected_reason, final_status, staff_id, created_at
       FROM crm_lead_supervisor_actions WHERE lotus_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.lotus_id]
    );
    res.json({ items: rows });
  } catch (e) { next(e); }
});

module.exports = router;
