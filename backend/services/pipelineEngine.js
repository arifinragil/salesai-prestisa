// Sales pipeline engine. Pure stage-transition logic + DB writers.
const pg = require('../db/postgres');
const logger = require('./logger');
const {
  STAGE_PROBABILITY, TERMINAL_STAGES, isStageForward,
} = require('./pipelineConstants');

// Event → resulting stage (without override consideration).
// Returns null if the event has no defined transition for the current stage.
function rawTransition(currentStage, event) {
  const t = event.type;

  // Lost transitions — orthogonal, win against current stage
  if (t === 'handover_refund' || t === 'handover_cancel' || t === 'spam_blocked') {
    return currentStage === 'lost' ? null : 'lost';
  }
  if (t === 'stale_no_reply') {
    if (currentStage === 'tertarik' || currentStage === 'form_dikirim') return 'lost';
    return null;
  }
  if (t === 'stale_baru_no_reply') {
    if (currentStage === 'baru') return 'lost';
    return null;
  }

  // Reactivation: only from lost (delivered intentionally excluded)
  if (t === 'customer_replied') {
    if (currentStage === 'lost') return 'tertarik';
    return null;
  }

  // Forward auto-transitions
  if (t === 'intent_qualified') {
    if (currentStage === 'baru') return 'tertarik';
    return null;
  }
  if (t === 'operator_claim') {
    if (currentStage === 'baru') return 'tertarik';
    return null;
  }
  if (t === 'order_url_sent') {
    if (currentStage === 'baru' || currentStage === 'tertarik') return 'form_dikirim';
    return null;
  }
  if (t === 'order_submitted') {
    if (['baru', 'tertarik', 'form_dikirim'].includes(currentStage)) return 'order_submitted';
    return null;
  }
  if (t === 'order_paid') {
    if (currentStage === 'order_submitted') return 'paid';
    return null;
  }
  if (t === 'order_delivered') {
    if (currentStage === 'paid') return 'delivered';
    return null;
  }

  return null;
}

// Compute target stage applying override semantics.
// Returns null if no transition (no-op).
function computeNextStage(currentStage, event, manualOverride) {
  const target = rawTransition(currentStage, event);
  if (target == null) return null;
  if (target === currentStage) return null;

  // Lost always wins (manual or not)
  if (target === 'lost') return target;

  // Reactivation always wins
  if (currentStage === 'lost') return target;

  // Manual override only blocks non-forward auto-transitions
  if (manualOverride && !isStageForward(currentStage, target)) {
    return null;
  }

  return target;
}

// Apply an event to a conversation. Persists transition + audit + history.
// Returns { applied, fromStage, toStage, reason }.
//
// options:
//   source       — string label for audit (e.g. 'auto:intent_classifier', 'manual:operator')
//   staffId      — optional staff_users.id for audit
//   force        — when true (manual operator action), use targetStage from event directly
//   metadata     — JSON to store on crm_pipeline_events.metadata
//   lostReason   — populated when toStage='lost'
//   lostNote     — free-text note for lost
async function apply(client, convId, event, options = {}) {
  const { rows } = await client.query(
    `SELECT pipeline_stage, manual_stage_override FROM crm_conversations WHERE id = $1`,
    [convId]
  );
  if (!rows[0]) {
    return { applied: false, reason: 'conv_not_found' };
  }
  const fromStage = rows[0].pipeline_stage;
  const overrideFlag = rows[0].manual_stage_override;

  let toStage;
  if (options.force && event.targetStage) {
    toStage = event.targetStage;
  } else {
    toStage = computeNextStage(fromStage, event, overrideFlag);
  }

  if (toStage == null || toStage === fromStage) {
    return { applied: false, fromStage, toStage: fromStage, reason: 'no_transition' };
  }

  let nextOverride = overrideFlag;
  if (options.force) {
    nextOverride = true;
  } else if (overrideFlag && isStageForward(fromStage, toStage)) {
    nextOverride = false;
  }

  const histEntry = {
    stage: toStage,
    at: new Date().toISOString(),
    by: options.staffId || null,
    source: options.source || 'unknown',
  };

  const setLost = toStage === 'lost';
  await client.query(
    `UPDATE crm_conversations
       SET pipeline_stage = $2,
           pipeline_stage_at = now(),
           manual_stage_override = $3,
           pipeline_stage_history = pipeline_stage_history || $4::jsonb,
           lost_reason = CASE WHEN $5 THEN $6 ELSE NULL END,
           lost_note   = CASE WHEN $5 THEN $7 ELSE NULL END,
           updated_at = now()
     WHERE id = $1`,
    [convId, toStage, nextOverride, JSON.stringify(histEntry),
     setLost, options.lostReason || null, options.lostNote || null]
  );

  await client.query(
    `INSERT INTO crm_pipeline_events
       (conversation_id, from_stage, to_stage, source, staff_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [convId, fromStage, toStage, options.source || 'unknown',
     options.staffId || null, JSON.stringify(options.metadata || {})]
  );

  logger.info({ convId, fromStage, toStage, source: options.source }, '[pipeline] transition');
  return { applied: true, fromStage, toStage, reason: 'transition_applied' };
}

// Set pipeline_type without changing stage. Idempotent unless force=true.
async function setType(client, convId, type, options = {}) {
  if (!options.force) {
    const r = await client.query(`SELECT pipeline_type FROM crm_conversations WHERE id = $1`, [convId]);
    if (r.rows[0]?.pipeline_type && r.rows[0].pipeline_type !== 'unknown') {
      return { applied: false, reason: 'type_already_set' };
    }
  }
  await client.query(
    `UPDATE crm_conversations SET pipeline_type = $2, updated_at = now() WHERE id = $1`,
    [convId, type]
  );
  return { applied: true };
}

// Set deal value (manual operator input for high-value segment).
async function setDealValue(client, convId, valueIdr, lock = false) {
  await client.query(
    `UPDATE crm_conversations
       SET deal_value_idr = $2, deal_value_locked = $3, updated_at = now()
     WHERE id = $1`,
    [convId, valueIdr, !!lock]
  );
}

// Auto-fill deal_value_idr + deal_order_id from MySQL order. Respects lock.
async function fillFromOrder(client, convId, orderId, valueIdr) {
  const r = await client.query(`SELECT deal_value_locked FROM crm_conversations WHERE id = $1`, [convId]);
  if (r.rows[0]?.deal_value_locked) {
    await client.query(
      `UPDATE crm_conversations SET deal_order_id = $2 WHERE id = $1`,
      [convId, orderId]
    );
    return;
  }
  await client.query(
    `UPDATE crm_conversations SET deal_order_id = $2, deal_value_idr = $3 WHERE id = $1`,
    [convId, orderId, valueIdr]
  );
}

// Pure: compute forecast totals from an array of conv rows.
function computeForecastFromRows(rows) {
  let expectedRevenue = 0;
  let realizedRevenue = 0;
  const byStage = {};
  for (const r of rows) {
    const stage = r.pipeline_stage;
    const v = Number(r.deal_value_idr) || 0;
    byStage[stage] ||= { count: 0, value: 0 };
    byStage[stage].count += 1;
    byStage[stage].value += v;

    if (v <= 0) continue;
    if (stage === 'delivered' || stage === 'paid') {
      realizedRevenue += v;
    } else if (!TERMINAL_STAGES.has(stage)) {
      expectedRevenue += v * (STAGE_PROBABILITY[stage] || 0);
    }
  }
  return {
    expectedRevenue: Math.round(expectedRevenue),
    realizedRevenue: Math.round(realizedRevenue),
    dealCount: rows.length,
    byStage,
  };
}

// DB-backed: filter active deals & call pure forecast.
async function computeForecast(filters = {}) {
  const where = ['1=1'];
  const params = [];
  if (filters.type) { params.push(filters.type); where.push(`pipeline_type = $${params.length}`); }
  if (filters.dateFrom) { params.push(filters.dateFrom); where.push(`pipeline_stage_at >= $${params.length}`); }
  const sql = `SELECT pipeline_stage, deal_value_idr FROM crm_conversations WHERE ${where.join(' AND ')}`;
  const { rows } = await pg.query(sql, params);
  return computeForecastFromRows(rows);
}

// Conversion rate from event log: count of distinct convs that reached each stage.
async function computeConversionRates(days = 30) {
  const { rows } = await pg.query(
    `SELECT to_stage, COUNT(DISTINCT conversation_id)::int AS n
     FROM crm_pipeline_events
     WHERE created_at > now() - ($1 || ' days')::interval
     GROUP BY to_stage`,
    [String(days)]
  );
  const counts = {};
  for (const r of rows) counts[r.to_stage] = r.n;
  const stageOrder = ['baru', 'tertarik', 'form_dikirim', 'order_submitted', 'paid', 'delivered'];
  const rates = {};
  for (let i = 1; i < stageOrder.length; i++) {
    const from = stageOrder[i - 1];
    const to = stageOrder[i];
    const fromN = counts[from] || 0;
    const toN = counts[to] || 0;
    rates[`${from}→${to}`] = fromN ? +(toN / fromN).toFixed(3) : 0;
  }
  return { rates, counts };
}

// Avg seconds spent per stage (for non-terminal stages currently in pipeline).
async function computeAvgTimePerStage() {
  const { rows } = await pg.query(
    `SELECT pipeline_stage,
            AVG(EXTRACT(EPOCH FROM (now() - pipeline_stage_at)))::int AS avg_seconds
     FROM crm_conversations
     WHERE pipeline_stage NOT IN ('delivered','lost')
     GROUP BY pipeline_stage`
  );
  const out = {};
  for (const r of rows) out[r.pipeline_stage] = Number(r.avg_seconds) || 0;
  return out;
}

async function topLostReasons(days = 30, limit = 5) {
  const { rows } = await pg.query(
    `SELECT lost_reason, COUNT(*)::int AS n FROM crm_conversations
     WHERE pipeline_stage='lost' AND pipeline_stage_at > now() - ($1 || ' days')::interval
       AND lost_reason IS NOT NULL
     GROUP BY lost_reason ORDER BY n DESC LIMIT $2`,
    [String(days), limit]
  );
  return rows;
}

module.exports = {
  computeNextStage,
  rawTransition,
  apply,
  setType,
  setDealValue,
  fillFromOrder,
  computeForecastFromRows,
  computeForecast,
  computeConversionRates,
  computeAvgTimePerStage,
  topLostReasons,
  STAGE_PROBABILITY,
  TERMINAL_STAGES,
};
