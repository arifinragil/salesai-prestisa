// Pipeline API — operator-facing CRUD + analytics.
const express = require('express');
const pg = require('../db/postgres');
const { requireStaff } = require('../middleware/auth');
const engine = require('../services/pipelineEngine');
const { STAGES, TYPES, LOST_REASONS } = require('../services/pipelineConstants');
const notify = require('../services/notify');

const router = express.Router();
router.use(requireStaff);

// GET /api/pipeline/board — list grouped by stage
router.get('/board', async (req, res) => {
  const where = ['1=1'];
  const params = [];
  if (req.query.type) { params.push(req.query.type); where.push(`c.pipeline_type = $${params.length}`); }
  if (req.query.claimed_by === 'me') {
    params.push(req.staff.staff_id);
    where.push(`EXISTS (SELECT 1 FROM crm_conversation_claims cl WHERE cl.conversation_id=c.id AND cl.released_at IS NULL AND cl.expires_at > now() AND cl.staff_id = $${params.length})`);
  } else if (req.query.claimed_by) {
    params.push(parseInt(req.query.claimed_by));
    where.push(`EXISTS (SELECT 1 FROM crm_conversation_claims cl WHERE cl.conversation_id=c.id AND cl.released_at IS NULL AND cl.expires_at > now() AND cl.staff_id = $${params.length})`);
  }
  if (req.query.tag_id) {
    params.push(parseInt(req.query.tag_id));
    where.push(`EXISTS (SELECT 1 FROM crm_conversation_tags ct WHERE ct.conversation_id=c.id AND ct.tag_id = $${params.length})`);
  }
  if (req.query.date_from) { params.push(req.query.date_from); where.push(`c.last_message_at >= $${params.length}`); }

  const { rows } = await pg.query(
    `SELECT c.id, c.phone, c.real_phone, c.push_name, c.pipeline_stage, c.pipeline_type,
            c.deal_value_idr, c.deal_value_locked, c.manual_stage_override,
            c.last_message_at, c.lost_reason,
            (SELECT json_agg(json_build_object('id',t.id,'name',t.name,'color',t.color))
             FROM crm_tags t JOIN crm_conversation_tags ct ON ct.tag_id=t.id
             WHERE ct.conversation_id=c.id) AS tags,
            h.score AS health_score, h.band AS health_band
     FROM crm_conversations c
     LEFT JOIN crm_customer_health h ON h.customer_id = c.customer_id
     WHERE ${where.join(' AND ')}
     ORDER BY c.pipeline_stage_at DESC LIMIT 1000`, params
  );
  const stages = {};
  for (const s of STAGES) stages[s] = [];
  for (const r of rows) (stages[r.pipeline_stage] || stages.baru).push(r);
  res.json({ success: true, stages });
});

// POST /api/pipeline/conversations/:id/stage — manual stage change
router.post('/conversations/:id/stage', async (req, res) => {
  const id = parseInt(req.params.id);
  const { stage, lost_reason, lost_note } = req.body || {};
  if (!STAGES.includes(stage)) return res.status(400).json({ success: false, message: `stage must be one of ${STAGES.join('|')}` });
  if (stage === 'lost' && !LOST_REASONS.includes(lost_reason)) {
    return res.status(400).json({ success: false, message: `lost_reason required: ${LOST_REASONS.join('|')}` });
  }
  if (stage === 'lost' && lost_reason === 'other_with_note' && !lost_note) {
    return res.status(400).json({ success: false, message: 'lost_note required when reason=other_with_note' });
  }
  const r = await engine.apply(pg, id, { type: 'manual_set', targetStage: stage }, {
    source: 'manual:operator', force: true, staffId: req.staff.staff_id,
    lostReason: lost_reason, lostNote: lost_note,
  });
  if (notify.notifyConvUpdated) notify.notifyConvUpdated(id);
  res.json({ success: true, ...r });
});

// POST /api/pipeline/conversations/:id/type — manual type change
router.post('/conversations/:id/type', async (req, res) => {
  const id = parseInt(req.params.id);
  const { type } = req.body || {};
  if (!TYPES.includes(type)) return res.status(400).json({ success: false, message: `type must be one of ${TYPES.join('|')}` });
  await engine.setType(pg, id, type, { force: true });
  res.json({ success: true });
});

// POST /api/pipeline/conversations/:id/value — manual deal value (wedding/b2b)
router.post('/conversations/:id/value', async (req, res) => {
  const id = parseInt(req.params.id);
  const value = parseInt(req.body?.value_idr);
  const lock = !!req.body?.lock;
  if (!Number.isFinite(value) || value < 0) {
    return res.status(400).json({ success: false, message: 'value_idr must be non-negative integer' });
  }
  const r = await pg.query(`SELECT pipeline_type FROM crm_conversations WHERE id=$1`, [id]);
  const t = r.rows[0]?.pipeline_type;
  if (!['wedding', 'b2b'].includes(t)) {
    return res.status(400).json({ success: false, message: 'manual deal value only allowed for wedding/b2b type (current: ' + t + ')' });
  }
  await engine.setDealValue(pg, id, value, lock);
  res.json({ success: true });
});

// POST /api/pipeline/conversations/:id/revert-stage — revert to previous stage in history
router.post('/conversations/:id/revert-stage', async (req, res) => {
  const id = parseInt(req.params.id);
  const { rows } = await pg.query(
    `SELECT pipeline_stage, pipeline_stage_history FROM crm_conversations WHERE id=$1`, [id]
  );
  if (!rows[0]) return res.status(404).json({ success: false, message: 'not found' });
  const hist = rows[0].pipeline_stage_history || [];
  const previous = [...hist].reverse().find((e) => e.stage !== rows[0].pipeline_stage);
  if (!previous) return res.status(400).json({ success: false, message: 'no previous stage to revert to' });
  const r = await engine.apply(pg, id, { type: 'manual_set', targetStage: previous.stage }, {
    source: 'manual:revert', force: true, staffId: req.staff.staff_id,
    metadata: { revert_from: rows[0].pipeline_stage },
  });
  if (notify.notifyConvUpdated) notify.notifyConvUpdated(id);
  res.json({ success: true, ...r });
});

// GET /api/pipeline/forecast
router.get('/forecast', async (req, res) => {
  const filters = {};
  if (req.query.type) filters.type = req.query.type;
  const days = parseInt(req.query.days) || 30;
  const [forecast, conv, avgTime, topLost, realized] = await Promise.all([
    engine.computeForecast(filters),
    engine.computeConversionRates(days),
    engine.computeAvgTimePerStage(),
    engine.topLostReasons(days, 5),
    pg.query(
      `SELECT COALESCE(SUM(deal_value_idr), 0)::bigint AS total
       FROM crm_conversations
       WHERE pipeline_stage='delivered' AND pipeline_stage_at > now() - interval '30 days'`
    ),
  ]);
  res.json({
    success: true,
    expected_revenue: forecast.expectedRevenue,
    realized_revenue_30d: Number(realized.rows[0].total),
    deal_count: forecast.dealCount,
    by_stage: forecast.byStage,
    conversion_rates: conv.rates,
    avg_time_per_stage_seconds: avgTime,
    top_lost_reasons: topLost,
  });
});

// GET /api/pipeline/events?conversation_id=X
router.get('/events', async (req, res) => {
  const convId = parseInt(req.query.conversation_id);
  if (!convId) return res.status(400).json({ success: false, message: 'conversation_id required' });
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const { rows } = await pg.query(
    `SELECT e.id, e.from_stage, e.to_stage, e.source, e.staff_id, e.metadata, e.created_at,
            u.full_name AS staff_name
     FROM crm_pipeline_events e
     LEFT JOIN staff_users u ON u.id = e.staff_id
     WHERE e.conversation_id = $1
     ORDER BY e.id DESC LIMIT $2`,
    [convId, limit]
  );
  res.json({ success: true, items: rows });
});

// Bulk stage change
router.post('/bulk-stage', async (req, res) => {
  const ids = (req.body?.conv_ids || []).map((n) => parseInt(n)).filter(Boolean);
  const { stage, lost_reason, lost_note } = req.body || {};
  if (!ids.length || !STAGES.includes(stage)) {
    return res.status(400).json({ success: false, message: `conv_ids + stage(${STAGES.join('|')}) required` });
  }
  if (stage === 'lost' && !LOST_REASONS.includes(lost_reason)) {
    return res.status(400).json({ success: false, message: `lost_reason required: ${LOST_REASONS.join('|')}` });
  }
  let ok = 0, failed = 0;
  const errors = [];
  for (const id of ids) {
    try {
      await engine.apply(pg, id, { type: 'manual_set', targetStage: stage }, {
        source: 'manual:operator_bulk', force: true, staffId: req.staff.staff_id,
        lostReason: lost_reason, lostNote: lost_note,
      });
      if (notify.notifyConvUpdated) notify.notifyConvUpdated(id);
      ok++;
    } catch (err) { failed++; errors.push({ conv_id: id, message: err.message }); }
  }
  res.json({ success: true, ok, failed, errors });
});

module.exports = router;
