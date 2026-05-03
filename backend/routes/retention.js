// backend/routes/retention.js
// Admin review/approve UI for retention followups (paused for review).
const express = require('express');
const pg = require('../db/postgres');
const { requireStaff } = require('../middleware/auth');
const router = express.Router();

router.use(requireStaff);
router.use((req, res, next) => {
  if (req.staff?.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  next();
});

// GET /pending — list followups awaiting admin review (status='cancelled', reason='pause_for_review')
router.get('/pending', async (req, res) => {
  const kind = req.query.kind || null;
  const params = [];
  let where = `status = 'cancelled' AND cancel_reason = 'pause_for_review'`;
  if (kind) { params.push(kind); where += ` AND kind = $${params.length}`; }
  const r = await pg.query(
    `SELECT f.id, f.conversation_id, f.kind, f.body_template, f.created_at, f.scheduled_for,
            c.phone, c.real_phone, c.push_name, c.customer_id, c.lead_temperature,
            ra.context, ra.promo_code
     FROM crm_followups f
     JOIN crm_conversations c ON c.id = f.conversation_id
     LEFT JOIN crm_retention_actions ra ON ra.followup_id = f.id
     WHERE ${where}
     ORDER BY f.kind, f.id LIMIT 500`,
    params
  );
  res.json({ items: r.rows });
});

// GET /counts — counts per kind
router.get('/counts', async (_req, res) => {
  const r = await pg.query(
    `SELECT kind, COUNT(*)::int AS n
     FROM crm_followups WHERE status = 'cancelled' AND cancel_reason = 'pause_for_review'
     GROUP BY kind ORDER BY kind`
  );
  res.json({ items: r.rows });
});

// POST /approve — un-pause one or many
router.post('/approve', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => parseInt(x)).filter(Number.isFinite) : null;
  const allKind = req.body?.all_kind ? String(req.body.all_kind) : null;
  if (!ids && !allKind) return res.status(400).json({ error: 'ids[] or all_kind required' });
  let r;
  if (ids?.length) {
    r = await pg.query(
      `UPDATE crm_followups SET status='pending', cancel_reason=NULL, cancelled_at=NULL,
              scheduled_for = now() + interval '5 minutes'
       WHERE id = ANY($1) AND status='cancelled' AND cancel_reason='pause_for_review'`,
      [ids]
    );
  } else {
    r = await pg.query(
      `UPDATE crm_followups SET status='pending', cancel_reason=NULL, cancelled_at=NULL,
              scheduled_for = now() + interval '5 minutes'
       WHERE kind = $1 AND status='cancelled' AND cancel_reason='pause_for_review'`,
      [allKind]
    );
  }
  res.json({ ok: true, updated: r.rowCount });
});

// POST /reject — permanently cancel (different reason so review filter excludes them)
router.post('/reject', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => parseInt(x)).filter(Number.isFinite) : null;
  if (!ids?.length) return res.status(400).json({ error: 'ids[] required' });
  const r = await pg.query(
    `UPDATE crm_followups SET cancel_reason = 'rejected_by_admin', cancelled_at = now()
     WHERE id = ANY($1) AND status='cancelled' AND cancel_reason='pause_for_review'`,
    [ids]
  );
  res.json({ ok: true, updated: r.rowCount });
});

// POST /run — manually trigger retention engine (generates fresh followups, paused)
router.post('/run', async (_req, res) => {
  const engine = require('../services/retentionEngine');
  try {
    const result = await engine.run();
    // Auto-pause everything just-generated for review
    await pg.query(
      `UPDATE crm_followups SET status = 'cancelled', cancel_reason = 'pause_for_review', cancelled_at = now()
       WHERE kind IN ('dormant_warm','dormant_cold','dormant_dead','winback','moment_birthday','moment_anniversary')
         AND status = 'pending' AND created_at > now() - interval '5 minutes'`
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
