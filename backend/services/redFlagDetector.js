// backend/services/redFlagDetector.js
// Per-rule evaluators for supervisor red flags. See spec §5.1.
//
// Each rule fn returns an array of candidate red flag rows.
// `record(candidates)` inserts them, deduping by (staff_id, conversation_id, rule_id)
// within a 24h window so the same incident isn't logged on every cron tick.

const pg = require('../db/postgres');
const settings = require('./settings');
const logger = require('./logger');

// Helper: insert flags, deduped by (staff, conv, rule) within 24h
async function record(candidates) {
  let inserted = 0;
  for (const c of candidates) {
    if (!c.staff_id || !c.rule_id || !c.severity) continue;
    const dup = await pg.query(
      `SELECT 1 FROM crm_agent_red_flags
       WHERE staff_id = $1 AND rule_id = $2
         AND COALESCE(conversation_id, -1) = COALESCE($3::int, -1)
         AND detected_at > now() - interval '24 hours'
         AND resolved_at IS NULL
       LIMIT 1`,
      [c.staff_id, c.rule_id, c.conversation_id || null]
    );
    if (dup.rows.length) continue;
    await pg.query(
      `INSERT INTO crm_agent_red_flags (staff_id, conversation_id, rule_id, severity, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [c.staff_id, c.conversation_id || null, c.rule_id, c.severity, JSON.stringify(c.detail || {})]
    );
    inserted++;
  }
  return inserted;
}

// ── Rule: slow_first_response (high) ─────────────────────────────────────
async function ruleSlowFirstResponse() {
  const sla = await settings.getSetting('first_response_sla_seconds', 60);
  const r = await pg.query(
    `SELECT c.id AS conversation_id, c.assigned_staff_id AS staff_id,
            EXTRACT(EPOCH FROM (c.first_response_at - c.first_inbound_at))::int AS resp_sec
     FROM crm_conversations c
     WHERE c.first_inbound_at IS NOT NULL
       AND c.first_response_at IS NOT NULL
       AND c.assigned_staff_id IS NOT NULL
       AND c.first_inbound_at > now() - interval '24 hours'
       AND EXTRACT(EPOCH FROM (c.first_response_at - c.first_inbound_at)) > $1`,
    [sla]
  );
  return r.rows.map((row) => ({
    staff_id: row.staff_id, conversation_id: row.conversation_id,
    rule_id: 'slow_first_response', severity: 'high',
    detail: { resp_sec: row.resp_sec, sla_sec: sla },
  }));
}

// ── Rule: missed_followup (high) ─────────────────────────────────────────
async function ruleMissedFollowup() {
  const sop = await settings.getSetting('followup_sop_minutes', 30);
  const r = await pg.query(
    `SELECT c.id AS conversation_id, c.assigned_staff_id AS staff_id,
            c.pipeline_stage,
            EXTRACT(EPOCH FROM (now() - c.pipeline_stage_at))::int / 60 AS stale_min
     FROM crm_conversations c
     WHERE c.pipeline_stage IN ('qualified','proposal_sent')
       AND c.status = 'active'
       AND c.assigned_staff_id IS NOT NULL
       AND c.pipeline_stage_at < now() - ($1 || ' minutes')::interval
       AND NOT EXISTS (
         SELECT 1 FROM crm_messages m
         WHERE m.conversation_id = c.id AND m.direction = 'out'
           AND m.sender_type IN ('staff','ai')
           AND m.created_at > c.pipeline_stage_at
       )`,
    [String(sop)]
  );
  return r.rows.map((row) => ({
    staff_id: row.staff_id, conversation_id: row.conversation_id,
    rule_id: 'missed_followup', severity: 'high',
    detail: { stage: row.pipeline_stage, stale_min: row.stale_min, sop_min: sop },
  }));
}

// ── Rule: suggestion_deviation (medium) ──────────────────────────────────
async function ruleSuggestionDeviation() {
  const thr = await settings.getSetting('suggestion_deviation_threshold', 0.3);
  const r = await pg.query(
    `SELECT staff_id, COUNT(*) AS n
     FROM crm_suggestion_log
     WHERE staff_id IS NOT NULL AND usage_type = 'edited'
       AND edit_distance > $1
       AND shown_at > now() - interval '24 hours'
     GROUP BY staff_id HAVING COUNT(*) >= 5`,
    [thr]
  );
  return r.rows.map((row) => ({
    staff_id: row.staff_id, rule_id: 'suggestion_deviation', severity: 'medium',
    detail: { high_edit_count: parseInt(row.n), threshold: thr },
  }));
}

// ── Rule: manual_override_high (medium) ──────────────────────────────────
async function ruleManualOverrideHigh() {
  const r = await pg.query(
    `SELECT staff_id,
            SUM(CASE WHEN usage_type='manual' THEN 1 ELSE 0 END)::int AS manual,
            COUNT(*)::int AS total
     FROM crm_suggestion_log
     WHERE staff_id IS NOT NULL AND usage_type IS NOT NULL
       AND shown_at > now() - interval '24 hours'
     GROUP BY staff_id HAVING COUNT(*) >= 5 AND
       SUM(CASE WHEN usage_type='manual' THEN 1 ELSE 0 END)::float / COUNT(*) > 0.5`
  );
  return r.rows.map((row) => ({
    staff_id: row.staff_id, rule_id: 'manual_override_high', severity: 'medium',
    detail: { manual: row.manual, total: row.total, ratio: Number((row.manual / row.total).toFixed(2)) },
  }));
}

// ── Rule: flagged_suggestion (low) ───────────────────────────────────────
async function ruleFlaggedSuggestion() {
  const r = await pg.query(
    `SELECT id, staff_id, conversation_id, flagged_reason
     FROM crm_suggestion_log
     WHERE flagged_reason IN ('harmful','off_tone')
       AND shown_at > now() - interval '24 hours'
       AND staff_id IS NOT NULL`
  );
  return r.rows.map((row) => ({
    staff_id: row.staff_id, conversation_id: row.conversation_id,
    rule_id: 'flagged_suggestion', severity: 'low',
    detail: { suggestion_log_id: row.id, reason: row.flagged_reason },
  }));
}

// ── Rule: lost_no_reason (medium) ────────────────────────────────────────
async function ruleLostNoReason() {
  const r = await pg.query(
    `SELECT c.id AS conversation_id, c.assigned_staff_id AS staff_id
     FROM crm_conversations c
     WHERE c.pipeline_stage = 'lost'
       AND c.lost_reason IS NULL
       AND c.assigned_staff_id IS NOT NULL
       AND c.pipeline_stage_at > now() - interval '24 hours'`
  );
  return r.rows.map((row) => ({
    staff_id: row.staff_id, conversation_id: row.conversation_id,
    rule_id: 'lost_no_reason', severity: 'medium', detail: {},
  }));
}

// ── Rule: csat_low (high) ────────────────────────────────────────────────
async function ruleCsatLow() {
  const r = await pg.query(
    `SELECT cs.id AS csat_id, cs.score, cs.conversation_id, c.assigned_staff_id AS staff_id
     FROM crm_csat cs JOIN crm_conversations c ON c.id = cs.conversation_id
     WHERE cs.score <= 2
       AND cs.collected_at > now() - interval '7 days'
       AND c.assigned_staff_id IS NOT NULL`
  );
  return r.rows.map((row) => ({
    staff_id: row.staff_id, conversation_id: row.conversation_id,
    rule_id: 'csat_low', severity: 'high',
    detail: { csat_id: row.csat_id, score: row.score },
  }));
}

// ── Rule: pii_leak (critical) ────────────────────────────────────────────
async function rulePiiLeak() {
  const PHONE_RE = /(?<!\d)(?:62|0)[\s.-]?\d{2,4}[\s.-]?\d{3,5}[\s.-]?\d{3,5}(?!\d)/g;
  const r = await pg.query(
    `SELECT m.id AS msg_id, m.conversation_id, m.body, c.phone, c.real_phone, c.assigned_staff_id AS staff_id
     FROM crm_messages m JOIN crm_conversations c ON c.id = m.conversation_id
     WHERE m.direction = 'out' AND m.sender_type = 'staff'
       AND m.created_at > now() - interval '1 hour'
       AND c.assigned_staff_id IS NOT NULL`
  );
  const flags = [];
  for (const row of r.rows) {
    const matches = String(row.body || '').match(PHONE_RE);
    if (!matches) continue;
    const ownPhones = [row.phone, row.real_phone].filter(Boolean).map((p) => String(p).replace(/\D/g, ''));
    const leaked = matches.filter((m) => {
      const norm = m.replace(/\D/g, '');
      return !ownPhones.some((p) => p.includes(norm) || norm.includes(p));
    });
    if (leaked.length === 0) continue;
    flags.push({
      staff_id: row.staff_id, conversation_id: row.conversation_id,
      rule_id: 'pii_leak', severity: 'critical',
      detail: { msg_id: row.msg_id, leaked_numbers: leaked.slice(0, 3) },
    });
  }
  return flags;
}

// ── Rule: policy_violation (high) ────────────────────────────────────────
async function rulePolicyViolation() {
  const blacklist = await settings.getSetting('policy_keyword_blacklist', []);
  if (!Array.isArray(blacklist) || blacklist.length === 0) return [];
  const r = await pg.query(
    `SELECT m.id AS msg_id, m.conversation_id, m.body, c.assigned_staff_id AS staff_id
     FROM crm_messages m JOIN crm_conversations c ON c.id = m.conversation_id
     WHERE m.direction = 'out' AND m.sender_type = 'staff'
       AND m.created_at > now() - interval '1 hour'
       AND c.assigned_staff_id IS NOT NULL`
  );
  const flags = [];
  for (const row of r.rows) {
    const lower = String(row.body || '').toLowerCase();
    const hit = blacklist.find((kw) => lower.includes(String(kw).toLowerCase()));
    if (!hit) continue;
    flags.push({
      staff_id: row.staff_id, conversation_id: row.conversation_id,
      rule_id: 'policy_violation', severity: 'high',
      detail: { msg_id: row.msg_id, keyword: hit },
    });
  }
  return flags;
}

// ── Rule: cold_lead_ignored (critical) ───────────────────────────────────
// Promote Phase 2's hot lead alerts (kind=supervisor_5min) into red flags.
async function ruleColdLeadIgnored() {
  const r = await pg.query(
    `SELECT a.id AS alert_id, a.conversation_id, a.staff_id, a.sent_at, c.assigned_staff_id
     FROM crm_hot_lead_alerts a
     JOIN crm_conversations c ON c.id = a.conversation_id
     WHERE a.alert_kind = 'supervisor_5min'
       AND a.sent_at > now() - interval '24 hours'`
  );
  return r.rows.map((row) => ({
    staff_id: row.assigned_staff_id || row.staff_id,
    conversation_id: row.conversation_id,
    rule_id: 'cold_lead_ignored', severity: 'critical',
    detail: { alert_id: row.alert_id, alerted_at: row.sent_at },
  })).filter((f) => f.staff_id);
}

// ── Rule: handover_overuse (low) ─────────────────────────────────────────
async function ruleHandoverOveruse() {
  const r = await pg.query(
    `SELECT c.assigned_staff_id AS staff_id,
            COUNT(DISTINCT c.id) FILTER (WHERE h.id IS NOT NULL)::int AS handovers,
            COUNT(DISTINCT c.id)::int AS total
     FROM crm_conversations c
     LEFT JOIN crm_handovers h ON h.conversation_id = c.id AND h.created_at > now() - interval '7 days'
     WHERE c.assigned_staff_id IS NOT NULL
       AND c.last_message_at > now() - interval '7 days'
     GROUP BY c.assigned_staff_id
     HAVING COUNT(DISTINCT c.id) >= 5
        AND COUNT(DISTINCT c.id) FILTER (WHERE h.id IS NOT NULL)::float / COUNT(DISTINCT c.id) > 0.3`
  );
  return r.rows.map((row) => ({
    staff_id: row.staff_id, rule_id: 'handover_overuse', severity: 'low',
    detail: { handovers: row.handovers, total: row.total, ratio: Number((row.handovers / row.total).toFixed(2)) },
  }));
}

async function evaluateRealtime() {
  return [
    ...(await ruleColdLeadIgnored().catch((e) => (logger.warn({err:e.message},'ruleColdLeadIgnored'),[]))),
    ...(await ruleFlaggedSuggestion().catch((e) => (logger.warn({err:e.message},'ruleFlaggedSuggestion'),[]))),
    ...(await rulePiiLeak().catch((e) => (logger.warn({err:e.message},'rulePiiLeak'),[]))),
    ...(await rulePolicyViolation().catch((e) => (logger.warn({err:e.message},'rulePolicyViolation'),[]))),
  ];
}

async function evaluateBatch() {
  return [
    ...(await ruleSlowFirstResponse().catch((e) => (logger.warn({err:e.message},'ruleSlowFirstResponse'),[]))),
    ...(await ruleMissedFollowup().catch((e) => (logger.warn({err:e.message},'ruleMissedFollowup'),[]))),
    ...(await ruleSuggestionDeviation().catch((e) => (logger.warn({err:e.message},'ruleSuggestionDeviation'),[]))),
    ...(await ruleManualOverrideHigh().catch((e) => (logger.warn({err:e.message},'ruleManualOverrideHigh'),[]))),
    ...(await ruleLostNoReason().catch((e) => (logger.warn({err:e.message},'ruleLostNoReason'),[]))),
    ...(await ruleCsatLow().catch((e) => (logger.warn({err:e.message},'ruleCsatLow'),[]))),
    ...(await ruleHandoverOveruse().catch((e) => (logger.warn({err:e.message},'ruleHandoverOveruse'),[]))),
  ];
}

module.exports = {
  evaluateRealtime, evaluateBatch, record,
  ruleSlowFirstResponse, ruleMissedFollowup, ruleSuggestionDeviation,
  ruleManualOverrideHigh, ruleFlaggedSuggestion, ruleLostNoReason,
  ruleCsatLow, rulePiiLeak, rulePolicyViolation, ruleColdLeadIgnored,
  ruleHandoverOveruse,
};
