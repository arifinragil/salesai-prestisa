// backend/routes/b2b.js — B2B outreach campaigns admin API.
const express = require('express');
const pg = require('../db/postgres');
const b2b = require('../services/b2bOutreach');
const { requireStaff } = require('../middleware/auth');
const router = express.Router();

router.use(requireStaff);
router.use((req, res, next) => {
  if (req.staff?.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  next();
});

// POST /preview — list prospects matching filters (no DB write)
router.post('/preview', async (req, res) => {
  try {
    const rows = await b2b.previewProspects(req.body || {});
    res.json({ items: rows, count: rows.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /campaigns — list campaigns
router.get('/campaigns', async (_req, res) => {
  const r = await pg.query(
    `SELECT c.id, c.name, c.status, c.created_at, c.launched_at, c.completed_at,
            (SELECT COUNT(*) FROM crm_b2b_prospects p WHERE p.campaign_id = c.id)::int AS total,
            (SELECT COUNT(*) FROM crm_b2b_prospects p WHERE p.campaign_id = c.id AND p.status = 'replied')::int AS replied,
            (SELECT COUNT(*) FROM crm_b2b_prospects p WHERE p.campaign_id = c.id AND p.status = 'opted_out')::int AS opted_out,
            (SELECT COUNT(*) FROM crm_b2b_prospects p WHERE p.campaign_id = c.id AND p.status = 'completed')::int AS completed,
            jsonb_array_length(c.sequence) AS step_count
     FROM crm_b2b_campaigns c
     ORDER BY c.id DESC LIMIT 100`
  );
  res.json({ items: r.rows });
});

// GET /campaigns/:id — full detail incl. prospects sample
router.get('/campaigns/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
  const c = await pg.query(`SELECT * FROM crm_b2b_campaigns WHERE id = $1`, [id]);
  if (!c.rows[0]) return res.status(404).json({ error: 'not_found' });
  const prospects = await pg.query(
    `SELECT id, customer_id, customer_name, phone, current_step, status, next_step_at, last_step_at, reply_at
     FROM crm_b2b_prospects WHERE campaign_id = $1 ORDER BY id LIMIT 500`, [id]
  );
  res.json({ campaign: c.rows[0], prospects: prospects.rows });
});

// POST /campaigns — create draft
router.post('/campaigns', async (req, res) => {
  try {
    const { name, sequence, filters, prospects } = req.body || {};
    const r = await b2b.createCampaign({ name, sequence, filters, prospects, createdBy: req.staff.staff_id });
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /campaigns/:id/launch
router.post('/campaigns/:id/launch', async (req, res) => {
  try { res.json(await b2b.launchCampaign(parseInt(req.params.id))); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /campaigns/:id/pause | /resume | /cancel
router.post('/campaigns/:id/pause',  async (req, res) => res.json(await b2b.setCampaignStatus(parseInt(req.params.id), 'paused')));
router.post('/campaigns/:id/resume', async (req, res) => res.json(await b2b.setCampaignStatus(parseInt(req.params.id), 'active')));
router.post('/campaigns/:id/cancel', async (req, res) => res.json(await b2b.setCampaignStatus(parseInt(req.params.id), 'cancelled')));

// POST /tick — manually trigger advance (admin debug)
router.post('/tick', async (_req, res) => {
  try { res.json(await b2b.tick()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
