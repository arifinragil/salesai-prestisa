const express = require('express');
const pg = require('../db/postgres');
const { requireStaff } = require('../middleware/auth');

const router = express.Router();
router.use(requireStaff);

// ── Persona ──────────────────────────────────────────────────────────────────

router.get('/personas', async (_req, res) => {
  const { rows } = await pg.query(
    `SELECT id, name, active, created_by, created_at,
            LEFT(prompt_text, 200) AS preview
     FROM crm_persona_prompts ORDER BY id DESC LIMIT 50`
  );
  res.json({ success: true, items: rows });
});

router.get('/personas/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { rows } = await pg.query(
    `SELECT id, name, prompt_text, active, created_by, created_at FROM crm_persona_prompts WHERE id = $1`, [id]
  );
  if (!rows[0]) return res.status(404).json({ success: false, message: 'not found' });
  res.json({ success: true, persona: rows[0] });
});

router.post('/personas', async (req, res) => {
  const { name, prompt_text } = req.body || {};
  if (!name || !prompt_text) return res.status(400).json({ success: false, message: 'name and prompt_text required' });
  const { rows } = await pg.query(
    `INSERT INTO crm_persona_prompts (name, prompt_text, active, created_by)
     VALUES ($1, $2, FALSE, $3) RETURNING id`,
    [name, prompt_text, req.staff.staff_id]
  );
  res.json({ success: true, id: rows[0].id });
});

router.post('/personas/:id/activate', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  const client = await pg.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE crm_persona_prompts SET active = FALSE WHERE active = TRUE`);
    const r = await client.query(`UPDATE crm_persona_prompts SET active = TRUE WHERE id = $1 RETURNING id`, [id]);
    if (!r.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'persona not found' });
    }
    await client.query('COMMIT');
    res.json({ success: true, active_id: id });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// ── Global toggles ───────────────────────────────────────────────────────────

router.post('/ai/global', (req, res) => {
  const enabled = !!req.body?.enabled;
  process.env.AI_GLOBAL_ENABLED = enabled ? 'true' : 'false';
  res.json({ success: true, enabled });
});

router.get('/ai/global', (_req, res) => {
  const enabled = String(process.env.AI_GLOBAL_ENABLED || 'true').toLowerCase() !== 'false';
  res.json({ success: true, enabled });
});

// ── Metrics ──────────────────────────────────────────────────────────────────

router.get('/metrics/today', async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const [queue, inbound, ai_sent, handovers] = await Promise.all([
    pg.query(`SELECT COUNT(*)::int AS n FROM crm_inbound_queue WHERE status = 'pending'`),
    pg.query(`SELECT COUNT(*)::int AS n FROM crm_messages WHERE direction = 'in' AND created_at::date = $1`, [today]),
    pg.query(`SELECT COUNT(*)::int AS n FROM crm_messages WHERE sender_type = 'ai' AND shadow = FALSE AND created_at::date = $1`, [today]),
    pg.query(`SELECT COUNT(*)::int AS n FROM crm_handovers WHERE created_at::date = $1`, [today]),
  ]);
  res.json({
    success: true,
    metrics: {
      date: today,
      queue_depth: queue.rows[0].n,
      inbound_today: inbound.rows[0].n,
      ai_sent_today: ai_sent.rows[0].n,
      handovers_today: handovers.rows[0].n,
    },
  });
});

router.get('/metrics/recent', async (_req, res) => {
  const { rows } = await pg.query(
    `SELECT date, total_inbound, total_ai_sent, total_handovers, unique_conversations,
            avg_latency_ms, total_tokens_in, total_tokens_out, cost_usd, handover_breakdown
     FROM crm_ai_metrics_daily ORDER BY date DESC LIMIT 30`
  );
  res.json({ success: true, items: rows });
});

router.get('/metrics/handover-breakdown', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const { rows } = await pg.query(
    `SELECT reason, COUNT(*)::int AS n
     FROM crm_handovers
     WHERE created_at >= now() - INTERVAL '${days} days'
     GROUP BY reason ORDER BY n DESC`
  );
  res.json({ success: true, breakdown: rows, days });
});

module.exports = router;
