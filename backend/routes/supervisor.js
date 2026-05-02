// backend/routes/supervisor.js
// Endpoints for /supervisor dashboard. Admin-only.
const express = require('express');
const pg = require('../db/postgres');
const { requireStaff } = require('../middleware/auth');
const router = express.Router();

router.use(requireStaff);
router.use((req, res, next) => {
  if (req.staff?.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  next();
});

// GET /agents — table for landing page (today + 7d trend + open red flag count)
router.get('/agents', async (_req, res) => {
  const r = await pg.query(
    `WITH today AS (
       SELECT staff_id, performance_score, conv_handled, conversion_rate
       FROM crm_agent_daily_scores
       WHERE date = current_date
     ),
     trend AS (
       SELECT staff_id, AVG(performance_score)::numeric(5,2) AS avg7d,
              ARRAY_AGG(performance_score ORDER BY date) AS series
       FROM crm_agent_daily_scores
       WHERE date >= current_date - interval '6 days'
       GROUP BY staff_id
     ),
     flags AS (
       SELECT staff_id, COUNT(*)::int AS open_flags
       FROM crm_agent_red_flags WHERE resolved_at IS NULL
       GROUP BY staff_id
     )
     SELECT u.id AS staff_id, u.username, u.full_name, u.role,
            u.coaching_status, u.coaching_set_at,
            t.performance_score AS today_score,
            tr.avg7d AS avg7d_score, tr.series AS series7d,
            COALESCE(f.open_flags, 0) AS open_flags,
            t.conv_handled, t.conversion_rate
     FROM staff_users u
     LEFT JOIN today t ON t.staff_id = u.id
     LEFT JOIN trend tr ON tr.staff_id = u.id
     LEFT JOIN flags f ON f.staff_id = u.id
     WHERE u.active = TRUE AND u.role IN ('operator','admin')
     ORDER BY COALESCE(t.performance_score, 0) DESC, u.username`
  );
  res.json({ items: r.rows });
});

// GET /agents/:id — drilldown
router.get('/agents/:id', async (req, res) => {
  const staffId = parseInt(req.params.id);
  if (!Number.isFinite(staffId)) return res.status(400).json({ error: 'bad_id' });
  const days = Math.min(90, parseInt(req.query.days) || 30);

  const [user, scores, flags, sugStats] = await Promise.all([
    pg.query(`SELECT id, username, full_name, role, active, last_login_at,
                     coaching_status, coaching_note, coaching_set_at, coaching_set_by
              FROM staff_users WHERE id = $1`, [staffId]),
    pg.query(
      `SELECT * FROM crm_agent_daily_scores
       WHERE staff_id = $1 AND date >= current_date - ($2 || ' days')::interval
       ORDER BY date DESC`,
      [staffId, String(days)]
    ),
    pg.query(
      `SELECT id, conversation_id, rule_id, severity, detail,
              detected_at, resolved_at, resolved_by, resolution_note
       FROM crm_agent_red_flags
       WHERE staff_id = $1 AND detected_at >= now() - ($2 || ' days')::interval
       ORDER BY detected_at DESC`,
      [staffId, String(days)]
    ),
    pg.query(
      `SELECT date_trunc('day', shown_at)::date AS day,
              COUNT(*)::int AS shown,
              SUM(CASE WHEN usage_type='raw' THEN 1 ELSE 0 END)::int AS used_raw,
              SUM(CASE WHEN usage_type='edited' THEN 1 ELSE 0 END)::int AS used_edited,
              SUM(CASE WHEN usage_type='manual' THEN 1 ELSE 0 END)::int AS manual
       FROM crm_suggestion_log
       WHERE staff_id = $1 AND shown_at >= now() - ($2 || ' days')::interval
       GROUP BY day ORDER BY day DESC`,
      [staffId, String(days)]
    ),
  ]);

  if (!user.rows[0]) return res.status(404).json({ error: 'staff_not_found' });
  res.json({
    staff: user.rows[0],
    scores: scores.rows,
    flags: flags.rows,
    suggestion_stats: sugStats.rows,
  });
});

// POST /agents/:id/coaching — set/clear coaching tag
router.post('/agents/:id/coaching', async (req, res) => {
  const staffId = parseInt(req.params.id);
  if (!Number.isFinite(staffId)) return res.status(400).json({ error: 'bad_id' });
  const { status, note } = req.body || {};
  const allowed = ['one_on_one_scheduled', 'remediation', 'probation'];
  if (status && !allowed.includes(status)) return res.status(400).json({ error: 'bad_status' });
  await pg.query(
    `UPDATE staff_users
     SET coaching_status = $2,
         coaching_note   = $3,
         coaching_set_at = CASE WHEN $2::varchar IS NULL THEN NULL ELSE now() END,
         coaching_set_by = CASE WHEN $2::varchar IS NULL THEN NULL ELSE $4 END
     WHERE id = $1`,
    [staffId, status || null, note ? String(note).slice(0, 500) : null, req.staff.staff_id]
  );
  res.json({ ok: true });
});

// POST /flags/:id/resolve — mark red flag resolved
router.post('/flags/:id/resolve', async (req, res) => {
  const flagId = parseInt(req.params.id);
  if (!Number.isFinite(flagId)) return res.status(400).json({ error: 'bad_id' });
  const note = String(req.body?.note || '').slice(0, 1000);
  const r = await pg.query(
    `UPDATE crm_agent_red_flags
     SET resolved_at = now(), resolved_by = $2, resolution_note = $3
     WHERE id = $1 AND resolved_at IS NULL
     RETURNING id`,
    [flagId, req.staff.staff_id, note || null]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found_or_already_resolved' });
  res.json({ ok: true });
});

module.exports = router;
