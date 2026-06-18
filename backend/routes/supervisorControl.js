// backend/routes/supervisorControl.js
// Supervisor Control — AI Diagnosis review + aksi supervisor. Admin-only.
const express = require('express');
const pg = require('../db/postgres');
const lotus = require('../db/lotus');
const { requireStaff } = require('../middleware/auth');
const { followupState } = require('../services/lotusFollowup');
const { classify } = require('../services/supervisorPriority');
const { STUCK_GROUP_OF, bucketOfGroup } = require('../services/stuckGroup');
const S = require('../services/supervisorSubsections');
const { promiseSql, PROMISE_RE, mapPromiseRow } = require('../services/salesPromise');
const { expectedCycle } = require('../services/followupHariH');
const { runTierA } = require('../services/analystReport');
const { getActiveExamples, formatExamplesBlock, createFromRevision } = require('../services/trainingExamples');
const { summarize, matchRate, issueBreakdown } = require('../services/supervisorRecap');

const router = express.Router();
router.use(requireStaff);
router.use((req, res, next) => {
  if (req.staff?.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  next();
});

const VALID_ACTIONS = new Set(['ack', 'resolve', 'reassign', 'request_fu', 'revise_ai']);

async function getStateMap(lotusIds) {
  if (!lotusIds.length) return new Map();
  const { rows } = await pg.query(`SELECT * FROM crm_lotus_state WHERE lotus_id = ANY($1::text[])`, [lotusIds]);
  return new Map(rows.map((r) => [r.lotus_id, r]));
}

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
    if (action === 'revise_ai' && corrected_root_cause) {
      await pg.query(
        `UPDATE crm_lotus_state SET root_cause_tag = $2, stuck_group = $3, stuck_issue = COALESCE($4, stuck_issue) WHERE lotus_id = $1`,
        [lotus_id, corrected_root_cause, STUCK_GROUP_OF(corrected_root_cause), corrected_reason || null]
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

const PRICE_RE = /harga|berapa|price|brp/i;
const REACTION_RE = /belum disupport oleh lotus \((reaction|sticker)\)/i;

// GET /panel — lead aktif dalam scope, dirakit jadi priority queue + 3 grup.
router.get('/panel', async (req, res, next) => {
  try {
    const scope = req.query.scope;
    const { rows: contacts } = await lotus.query(
      `WITH recent AS (
         SELECT c.lotus_id, c.cust_number, c.cust_name, c.business_number, c.assign_to_user_name,
                c.last_message, c.last_message_from, c.last_message_at, c.last_inbound_at
         FROM contacts c
         WHERE GREATEST(c.last_message_at, c.last_inbound_at) >= now() - interval '3 days'
         ORDER BY GREATEST(c.last_message_at, c.last_inbound_at) DESC NULLS LAST
         LIMIT 1000
       )
       SELECT r.lotus_id, r.cust_number, r.cust_name, r.business_number, r.assign_to_user_name, r.last_message,
              COALESCE(lm.direction, r.last_message_from) AS last_message_from,
              COALESCE(lm.received_at, r.last_message_at) AS last_message_at,
              fim.received_at AS first_inbound_at,
              lo.received_at  AS last_outbound_at,
              fo.received_at  AS first_outbound_at,
              COALESCE(ic.n, 0) AS inbound_count,
              COALESCE(ft.n, 0) AS fu_count_today,
              COALESCE(lib.len,0) AS last_in_len,
              gh.last_out_human AS last_out_human_at,
              lia.last_in_at AS last_in_at,
              fud.fu AS fu_times_today
       FROM recent r
       LEFT JOIN LATERAL (SELECT received_at, direction FROM messages m WHERE m.cust_number=r.cust_number ORDER BY received_at DESC NULLS LAST, id DESC LIMIT 1) lm ON true
       LEFT JOIN LATERAL (SELECT received_at FROM messages m WHERE m.cust_number=r.cust_number AND m.direction='inbound' ORDER BY received_at ASC NULLS LAST, id ASC LIMIT 1) fim ON true
       LEFT JOIN LATERAL (SELECT received_at FROM messages m WHERE m.cust_number=r.cust_number AND m.direction='outbound' ORDER BY received_at DESC NULLS LAST, id DESC LIMIT 1) lo ON true
       LEFT JOIN LATERAL (SELECT received_at FROM messages m WHERE m.cust_number=r.cust_number AND m.direction='outbound' ORDER BY received_at ASC NULLS LAST, id ASC LIMIT 1) fo ON true
       LEFT JOIN LATERAL (SELECT COUNT(*) n FROM messages m WHERE m.cust_number=r.cust_number AND m.direction='inbound') ic ON true
       LEFT JOIN LATERAL (SELECT COUNT(*) n FROM messages m WHERE m.cust_number=r.cust_number AND m.direction='outbound' AND m.received_at::date = now()::date) ft ON true
       LEFT JOIN LATERAL (SELECT length(COALESCE(m.body,'')) AS len FROM messages m
         WHERE m.cust_number=r.cust_number AND m.direction='inbound'
         ORDER BY m.received_at DESC NULLS LAST, id DESC LIMIT 1) lib ON true
       LEFT JOIN LATERAL (SELECT MAX(m.received_at) AS last_out_human FROM messages m
         WHERE m.cust_number=r.cust_number AND m.direction='outbound' AND m.cs_id IS NOT NULL) gh ON true
       LEFT JOIN LATERAL (SELECT MAX(m.received_at) AS last_in_at FROM messages m
         WHERE m.cust_number=r.cust_number AND m.direction='inbound') lia ON true
       LEFT JOIN LATERAL (SELECT array_agg(m.received_at ORDER BY m.received_at) AS fu FROM messages m
         WHERE m.cust_number=r.cust_number AND m.direction='outbound' AND m.cs_id IS NOT NULL
           AND m.received_at::date = now()::date) fud ON true`
    );
    const stateMap = await getStateMap(contacts.map((c) => c.lotus_id));
    const now = new Date();
    const minsSince = (ts) => ts ? (now.getTime() - new Date(ts).getTime()) / 60000 : null;

    const items = [];
    for (const c of contacts) {
      const s = stateMap.get(c.lotus_id) || {};
      if ((s.status || 'active') !== 'active') continue;
      if (scope === 'mine' && (s.assigned_staff_id ?? null) !== req.staff.staff_id) continue;

      const inbound = /^(in|customer)/i.test(String(c.last_message_from || ''));
      const firstInbound = s.first_inbound_at || c.first_inbound_at;
      const fu = followupState({ first_inbound_at: firstInbound, last_outbound_at: c.last_outbound_at }, now);
      const hoursSinceH = (ts) => ts ? (now.getTime() - new Date(ts).getTime()) / 3600000 : null;
      const lastInAfterOut = c.last_in_at && (!c.last_out_human_at || new Date(c.last_in_at) > new Date(c.last_out_human_at));
      const lastInIsReaction = lastInAfterOut && REACTION_RE.test(String(c.last_message || ''));
      const ghostHours = (c.last_out_human_at && (!c.last_in_at || new Date(c.last_in_at) < new Date(c.last_out_human_at)))
        ? hoursSinceH(c.last_out_human_at) : null;
      const expCycle = expectedCycle({ first_inbound_at: firstInbound, fu_times: c.fu_times_today || [] }, now);
      const lead = {
        status: s.status || 'active',
        never_responded: !c.last_outbound_at,
        awaiting_sales_reply_min: inbound ? minsSince(c.last_message_at) : null,
        awaiting_customer_reply_min: !inbound ? minsSince(c.last_message_at) : null,
        first_response_lag_min: (c.first_inbound_at && c.first_outbound_at) ? (new Date(c.first_outbound_at).getTime() - new Date(c.first_inbound_at).getTime()) / 60000 : null,
        single_bubble: Number(c.inbound_count) === 1,
        fu_status: fu.status,
        lead_temperature: s.lead_temperature, lead_score: s.lead_score,
        last_intent: s.last_intent, customer_intent: s.customer_intent,
        root_cause_tag: s.root_cause_tag, funnel_stage_lost: s.funnel_stage_lost,
        asked_price: PRICE_RE.test(String(c.last_message || '')),
      };
      const cls = classify(lead);
      let stuck_bucket = cls.stuck_bucket, stuck_label = cls.stuck_label, groups = cls.groups;
      if (s.stuck_group) {
        stuck_bucket = bucketOfGroup(s.stuck_group);
        stuck_label = s.stuck_issue || s.stuck_group;
        if (!groups.includes('lead_stuck')) groups = [...groups, 'lead_stuck'];
      }
      items.push({
        lotus_id: c.lotus_id, cust_name: c.cust_name, pic_name: c.assign_to_user_name || null,
        lead_in_at: firstInbound, last_message: c.last_message,
        last_message_from: c.last_message_from, last_message_at: c.last_message_at,
        awaiting_min: lead.awaiting_sales_reply_min ?? lead.awaiting_customer_reply_min, status: lead.status,
        priority: cls.priority, groups, stuck_bucket, stuck_label,
        fu_status: fu.status, fu_current_cycle: fu.current_cycle, fu_count_today: Number(c.fu_count_today) || 0,
        last_outbound_at: c.last_outbound_at, never_responded: lead.never_responded,
        root_cause_tag: s.root_cause_tag, funnel_stage_lost: s.funnel_stage_lost, lead_status: s.lead_status,
        controllability: s.controllability, sales_handling: s.sales_handling, evidence_quote: s.evidence_quote,
        analyst_report_generated_at: s.analyst_report_generated_at,
        // New sub-section fields
        last_in_len: Number(c.last_in_len) || 0,
        last_in_after_out: lastInAfterOut,
        last_in_is_reaction: lastInIsReaction,
        ghost_hours: ghostHours,
        expected_cycle: expCycle,
        no_reply_yet: lead.never_responded && !!c.first_inbound_at,
        first_response_lag_min: lead.first_response_lag_min,
        awaiting_sales_reply_min: lead.awaiting_sales_reply_min,
        awaiting_customer_reply_min: lead.awaiting_customer_reply_min,
        inbound_count: Number(c.inbound_count) || 0,
      });
    }

    const RANK = { P1: 0, P2: 1, P3: 2 };
    const priority_queue = items.filter((i) => i.priority)
      .sort((a, b) => (RANK[a.priority] - RANK[b.priority]) || ((b.awaiting_min || 0) - (a.awaiting_min || 0)));

    const groups = { sales_response_risk: [], follow_up: [], lead_stuck: { A: [], B: [], C: [], D: [] } };
    for (const i of items) {
      if (i.groups.includes('sales_response_risk')) groups.sales_response_risk.push(i);
      if (i.groups.includes('follow_up')) groups.follow_up.push(i);
      if (i.groups.includes('lead_stuck') && i.stuck_bucket) groups.lead_stuck[i.stuck_bucket].push(i);
    }
    // True counts sebelum di-cap; tampilan dibatasi CAP baris/list agar panel ringan & fokus.
    const CAP = 50;
    const capN = (arr) => arr.slice(0, CAP);
    const group_counts = {
      sales_response_risk: groups.sales_response_risk.length,
      follow_up: groups.follow_up.length,
      lead_stuck: Object.fromEntries(Object.entries(groups.lead_stuck).map(([k, v]) => [k, v.length])),
    };
    groups.sales_response_risk = groups.sales_response_risk.slice(0, CAP);
    groups.follow_up = groups.follow_up.slice(0, CAP);
    for (const k of ['A', 'B', 'C', 'D']) groups.lead_stuck[k] = groups.lead_stuck[k].slice(0, CAP);

    // Promise pass + new sub-section grouping (runs after CAP is declared)
    const byLotus = new Map(contacts.map((c) => [c.lotus_id, c]));
    const custNumbers = contacts.map((c) => c.cust_number).filter(Boolean);
    let promiseByCust = new Map();
    if (custNumbers.length) {
      const { rows: pr } = await lotus.query(promiseSql(), [custNumbers, PROMISE_RE.source]);
      const cByCust = new Map(contacts.map((c) => [c.cust_number, c]));
      promiseByCust = new Map(pr.map((row) => {
        const c = cByCust.get(row.cust_number) || {};
        return [row.cust_number, mapPromiseRow({ ...row, lotus_id: c.lotus_id, cust_name: c.cust_name, assign_to_user_name: c.assign_to_user_name }, now)];
      }));
    }
    const responseRisk = { customerWaiting: [], slowFirstResponse: [], salesPromiseBroken: [] };
    const followUp = { customerGhost: [], bubbleChat: [], pendingFuByCycle: { 1: [], 2: [], 3: [] } };
    const leadStuckByCategory = { A: [], B: [], C: [], D: [], uncategorized: [] };
    for (const i of items) {
      if (S.isCustomerWaiting(i)) responseRisk.customerWaiting.push(i);
      const sfr = S.slowFirstResponse(i); if (sfr) responseRisk.slowFirstResponse.push(i);
      if (S.isCustomerGhost(i)) followUp.customerGhost.push(i);
      if (S.isBubbleChat(i)) followUp.bubbleChat.push(i);
      if (i.expected_cycle) followUp.pendingFuByCycle[i.expected_cycle].push(i);
      const cust = byLotus.get(i.lotus_id);
      const p = cust && promiseByCust.get(cust.cust_number);
      if (p) responseRisk.salesPromiseBroken.push({ ...i, ...p });
      if (i.groups.includes('lead_stuck')) {
        if (i.stuck_bucket) leadStuckByCategory[i.stuck_bucket].push(i);
        else leadStuckByCategory.uncategorized.push(i);
      }
    }
    const p1Items = {
      customerWaitingCritical: responseRisk.customerWaiting.length,
      leadNoReply: responseRisk.slowFirstResponse.filter((i) => i.no_reply_yet).length,
      salesPromiseBroken: responseRisk.salesPromiseBroken.length,
    };
    const p2Items = {
      customerGhost: followUp.customerGhost.length,
      fuCycleIncomplete: followUp.pendingFuByCycle[1].length + followUp.pendingFuByCycle[2].length + followUp.pendingFuByCycle[3].length,
      leadStuck: ['A', 'B', 'C', 'D', 'uncategorized'].reduce((a, k) => a + leadStuckByCategory[k].length, 0),
    };
    const p3Items = {
      bubbleChat: followUp.bubbleChat.length,
      slowFirstResponseMild: responseRisk.slowFirstResponse.filter((i) => !i.no_reply_yet).length,
    };
    const sumv = (o) => Object.values(o).reduce((a, b) => a + b, 0);

    res.json({
      priority_queue: priority_queue.slice(0, CAP), groups,
      counts: { P1: priority_queue.filter((i) => i.priority === 'P1').length,
                P2: priority_queue.filter((i) => i.priority === 'P2').length,
                P3: priority_queue.filter((i) => i.priority === 'P3').length,
                total: items.length, queue_total: priority_queue.length, groups: group_counts, cap: CAP },
      responseRisk: { customerWaiting: capN(responseRisk.customerWaiting), slowFirstResponse: capN(responseRisk.slowFirstResponse), salesPromiseBroken: capN(responseRisk.salesPromiseBroken) },
      followUp: { customerGhost: capN(followUp.customerGhost), bubbleChat: capN(followUp.bubbleChat),
        pendingFuByCycle: { 1: capN(followUp.pendingFuByCycle[1]), 2: capN(followUp.pendingFuByCycle[2]), 3: capN(followUp.pendingFuByCycle[3]) } },
      leadStuckByCategory: Object.fromEntries(Object.entries(leadStuckByCategory).map(([k, v]) => [k, capN(v)])),
      priority: { p1: sumv(p1Items), p1Items, p2: sumv(p2Items), p2Items, p3: sumv(p3Items), p3Items, total: sumv(p1Items) + sumv(p2Items) + sumv(p3Items) },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { next(e); }
});

// ─── diagnoseLead helper ─────────────────────────────────────────────────────
// Mirrors cron_analyst_tier_a_prewarm.js single-lead path exactly.
// loadTranscript is not exported from the cron, so it is copied verbatim here.
const MAX_TRANSCRIPT_MSGS = 80;

async function _loadTranscript(custNumber, businessNumber) {
  const rows = (await lotus.query(
    `SELECT direction, body, message_type, received_at, cs_name
       FROM messages
      WHERE cust_number = $1 AND business_number = $2
      ORDER BY received_at ASC NULLS LAST, id ASC
      LIMIT $3`,
    [custNumber, businessNumber, MAX_TRANSCRIPT_MSGS]
  )).rows;
  return {
    transcript: rows.map(m => {
      const who = m.direction === 'inbound' ? 'Customer'
                : (m.cs_name ? `Operator (${m.cs_name})` : 'Operator');
      return `${who}: ${(m.body || `[${m.message_type}]`).slice(0, 300)}`;
    }).join('\n'),
    msgCount: rows.length,
    inboundCount: rows.filter(m => m.direction === 'inbound').length,
  };
}

async function diagnoseLead(lotus_id) {
  // 1. Resolve cust_number + business_number for this lotus_id
  const contactRes = await lotus.query(
    `SELECT cust_number, business_number FROM contacts WHERE lotus_id = $1 LIMIT 1`,
    [lotus_id]
  );
  if (!contactRes.rows.length) throw new Error(`lotus_id not found: ${lotus_id}`);
  const { cust_number, business_number } = contactRes.rows[0];

  // 2. Build transcript (same ordering/slicing the cron uses)
  const { transcript, msgCount, inboundCount } = await _loadTranscript(cust_number, business_number);
  if (inboundCount < 1) throw new Error(`Not enough inbound messages for lotus_id: ${lotus_id}`);

  // 3. Fetch last-15 revise_ai corrections (same query the cron uses)
  const corrections = (await pg.query(
    `SELECT corrected_root_cause AS to, corrected_reason AS reason FROM crm_lead_supervisor_actions
     WHERE action='revise_ai' AND corrected_root_cause IS NOT NULL ORDER BY created_at DESC LIMIT 15`
  )).rows;

  // 4. Build examples block
  const examplesBlock = formatExamplesBlock(await getActiveExamples());

  // 5. Call runTierA
  const { validated } = await runTierA({
    transcript, msgCount, inboundCount,
    geminiKey: process.env.GEMINI_API_KEY,
    corrections, examplesBlock,
  });

  // 6. UPSERT validated fields into crm_lotus_state (same column set + ON CONFLICT as cron)
  await pg.query(
    `INSERT INTO crm_lotus_state (lotus_id, root_cause_tag,
        lead_status, funnel_stage_lost, customer_intent, no_response_after,
        controllability, decision_maker, internal_root_cause_categories,
        sales_handling, product_solution_fit, confidence_v2, evidence_quote,
        stuck_group, stuck_issue,
        analyst_report_generated_at, analyst_report_msg_count, root_cause_tagged_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now(), $16, now())
     ON CONFLICT (lotus_id) DO UPDATE SET
        root_cause_tag = EXCLUDED.root_cause_tag,
        lead_status = EXCLUDED.lead_status,
        funnel_stage_lost = EXCLUDED.funnel_stage_lost,
        customer_intent = EXCLUDED.customer_intent,
        no_response_after = EXCLUDED.no_response_after,
        controllability = EXCLUDED.controllability,
        decision_maker = EXCLUDED.decision_maker,
        internal_root_cause_categories = EXCLUDED.internal_root_cause_categories,
        sales_handling = EXCLUDED.sales_handling,
        product_solution_fit = EXCLUDED.product_solution_fit,
        confidence_v2 = EXCLUDED.confidence_v2,
        evidence_quote = EXCLUDED.evidence_quote,
        stuck_group = EXCLUDED.stuck_group,
        stuck_issue = EXCLUDED.stuck_issue,
        analyst_report_generated_at = now(),
        analyst_report_msg_count = EXCLUDED.analyst_report_msg_count,
        root_cause_tagged_at = now()`,
    [lotus_id, validated.customer_reason,
     validated.lead_status, validated.funnel_stage_lost, validated.customer_intent, validated.no_response_after,
     validated.controllability, validated.decision_maker, validated.internal_root_cause_categories,
     validated.sales_handling, validated.product_solution_fit, validated.confidence, validated.evidence_quote,
     validated.stuck_group, validated.stuck_issue,
     msgCount]
  );

  return validated;
}

// ─── POST /:lotus_id/diagnose ────────────────────────────────────────────────
router.post('/:lotus_id/diagnose', async (req, res, next) => {
  try { const out = await diagnoseLead(req.params.lotus_id); res.json({ ok: true, diagnosis: out }); }
  catch (e) { next(e); }
});

// ─── POST /diagnosis/:lotus_id/review ───────────────────────────────────────
router.post('/diagnosis/:lotus_id/review', async (req, res, next) => {
  try {
    const { lotus_id } = req.params;
    const { agree_with_ai, revise_category, revise_subtype, revise_note, solved, supervisor_todo, supervisor_outcome } = req.body || {};
    if (typeof agree_with_ai !== 'boolean' || typeof solved !== 'boolean')
      return res.status(400).json({ error: 'agree_with_ai and solved required' });
    if (agree_with_ai === false && !revise_note)
      return res.status(400).json({ error: 'revise_note required when disagreeing' });
    const ins = await pg.query(
      `INSERT INTO crm_lead_supervisor_actions (lotus_id, staff_id, action, note, corrected_root_cause, corrected_reason, final_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [lotus_id, req.staff.staff_id, solved ? 'resolve' : 'ack', supervisor_todo || null,
       revise_category || null, revise_note || null, supervisor_outcome || null]);
    await pg.query(
      `UPDATE crm_lotus_state SET supervisor_agree_with_ai=$2, supervisor_todo=$3, supervisor_solved=$4,
         supervisor_outcome=$5, supervisor_ack_at=now(), supervisor_ack_by=$6 WHERE lotus_id=$1`,
      [lotus_id, agree_with_ai, supervisor_todo || null, solved, supervisor_outcome || null, req.staff.staff_id]);
    let exampleId = null;
    if (agree_with_ai === false && revise_category && revise_note) {
      exampleId = await createFromRevision({ action_id: ins.rows[0].id, category: revise_category,
        subtype: revise_subtype, analysis: revise_note, created_by: req.staff.staff_id });
    }
    res.json({ ok: true, action_id: ins.rows[0].id, training_example_id: exampleId });
  } catch (e) { next(e); }
});

// ─── POST /:lotus_id/review-no-diagnose ─────────────────────────────────────
router.post('/:lotus_id/review-no-diagnose', async (req, res, next) => {
  try {
    const { lotus_id } = req.params;
    const { solved, supervisor_todo, revise_category, revise_note, supervisor_outcome } = req.body || {};
    await pg.query(
      `UPDATE crm_lotus_state SET root_cause_tag = COALESCE($2, root_cause_tag), stuck_issue = COALESCE($3, stuck_issue),
         supervisor_todo=$4, supervisor_solved=$5, supervisor_outcome=$6, supervisor_ack_at=now(), supervisor_ack_by=$7,
         analyst_report_generated_at = COALESCE(analyst_report_generated_at, now()) WHERE lotus_id=$1`,
      [lotus_id, revise_category || null, revise_note || null, supervisor_todo || null, !!solved, supervisor_outcome || null, req.staff.staff_id]);
    await pg.query(
      `INSERT INTO crm_lead_supervisor_actions (lotus_id, staff_id, action, note, corrected_root_cause, corrected_reason, final_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [lotus_id, req.staff.staff_id, solved ? 'resolve' : 'ack', supervisor_todo || null, revise_category || null, revise_note || null, supervisor_outcome || null]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ─── POST /bulk-diagnose ─────────────────────────────────────────────────────
router.post('/bulk-diagnose', async (req, res, next) => {
  try {
    const ids = (req.body?.lotus_ids || []).slice(0, 100);
    let succeeded = 0, failed = 0; const errors = [];
    for (const id of ids) {
      try { await diagnoseLead(id); succeeded++; }
      catch (e) { failed++; errors.push({ id, error: e.message }); }
      await new Promise((r) => setTimeout(r, 200));
    }
    res.json({ processed: ids.length, succeeded, failed, errors });
  } catch (e) { next(e); }
});

// ─── GET /actions (compliance backlog) ──────────────────────────────────────
router.get('/actions', async (req, res, next) => {
  try {
    const range = parseInt(req.query.range) || 30;
    const dateFrom = req.query.date_from, dateTo = req.query.date_to;
    const where = (dateFrom && dateTo)
      ? `WHERE s.updated_at >= $1 AND s.updated_at < ($2::date + 1)`
      : `WHERE s.updated_at >= now() - ($1 || ' days')::interval`;
    const params = (dateFrom && dateTo) ? [dateFrom, dateTo] : [String(range)];
    const { rows: leads } = await pg.query(
      `SELECT s.lotus_id, s.supervisor_solved, s.supervisor_ack_at, s.supervisor_ack_by, s.root_cause_tag, s.stuck_group, s.assigned_staff_id,
              su.full_name AS supervisor_name
       FROM crm_lotus_state s LEFT JOIN staff_users su ON su.id=s.supervisor_ack_by
       ${where} AND (s.stuck_group IS NOT NULL OR s.supervisor_ack_at IS NOT NULL)
       ORDER BY s.supervisor_ack_at DESC NULLS LAST LIMIT 500`, params);
    const summary = summarize(leads);
    const bySup = {};
    for (const l of leads.filter((x) => x.supervisor_ack_by)) {
      const k = l.supervisor_ack_by;
      bySup[k] = bySup[k] || { supervisor_id: k, supervisor_name: l.supervisor_name, handled: 0, done: 0, open: 0 };
      bySup[k].handled++; l.supervisor_solved ? bySup[k].done++ : bySup[k].open++;
    }
    const bySupervisor = Object.values(bySup).map((b) => ({ ...b, compliance_pct: b.handled ? Math.round((b.done/b.handled)*100) : 0 }));
    res.json({ summary: { ...summary, range_days: (dateFrom&&dateTo)?undefined:range, date_from: dateFrom, date_to: dateTo }, bySupervisor, tasks: leads.slice(0, 500) });
  } catch (e) { next(e); }
});

// ─── GET /daily-recap ────────────────────────────────────────────────────────
router.get('/daily-recap', async (req, res, next) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const { rows: leads } = await pg.query(
      `SELECT s.lotus_id, s.stuck_group, s.supervisor_agree_with_ai, s.supervisor_ack_at, s.supervisor_solved,
              s.supervisor_outcome, s.supervisor_ack_by, su.full_name AS supervisor_name
       FROM crm_lotus_state s LEFT JOIN staff_users su ON su.id = s.supervisor_ack_by
       WHERE s.supervisor_ack_at::date = $1 OR s.analyst_report_generated_at::date = $1`, [date]);
    const withBucket = leads.map((l) => ({ ...l, stuck_bucket: l.stuck_group ? bucketOfGroup(l.stuck_group) : null }));
    const issue = issueBreakdown(withBucket);
    const match = matchRate(leads);
    const { rows: actions } = await pg.query(
      `SELECT a.lotus_id, a.staff_id, a.action, a.note, a.final_status, a.created_at, su.full_name AS supervisor_name
       FROM crm_lead_supervisor_actions a LEFT JOIN staff_users su ON su.id = a.staff_id
       WHERE a.created_at::date = $1 ORDER BY a.created_at DESC LIMIT 200`, [date]);
    const bySupMap = {};
    for (const a of actions) {
      const k = a.staff_id;
      bySupMap[k] = bySupMap[k] || { supervisor_id: k, supervisor_name: a.supervisor_name, total: 0, solved: 0, in_progress: 0, actions_sample: [] };
      bySupMap[k].total++;
      if (a.action === 'resolve') bySupMap[k].solved++; else bySupMap[k].in_progress++;
      if (bySupMap[k].actions_sample.length < 3) bySupMap[k].actions_sample.push({ lotus_id: a.lotus_id, note: a.note });
    }
    const bubble = { total: 0, closing: 0, fu_done: 0, sales_replied: 0, lost: 0, no_action: 0 };
    for (const l of leads) {
      bubble.total++;
      switch (l.supervisor_outcome) {
        case 'closing': bubble.closing++; break;
        case 'still_fu': bubble.fu_done++; break;
        case 'lost': bubble.lost++; break;
        case 'parked': bubble.sales_replied++; break;
        default: bubble.no_action++;
      }
    }
    res.json({
      date,
      issueBreakdown: { byCategory: issue.byCategory, total: issue.total, aiQuality: match },
      matchRate: match,
      actions,
      bySupervisor: Object.values(bySupMap),
      bubbleProgress: { summary: bubble },
    });
  } catch (e) { next(e); }
});

// ─── Training-examples CRUD ──────────────────────────────────────────────────
router.get('/training-examples', async (req, res, next) => {
  try {
    const active = req.query.active;
    const where = active === 'true' ? 'WHERE active=TRUE' : active === 'false' ? 'WHERE active=FALSE' : '';
    const { rows } = await pg.query(
      `SELECT t.*, su.full_name AS created_by_name FROM crm_ai_training_examples t
       LEFT JOIN staff_users su ON su.id=t.created_by ${where} ORDER BY t.updated_at DESC LIMIT 200`);
    const stats = await pg.query(
      `SELECT COUNT(*) FILTER (WHERE active) AS active_count,
              COUNT(*) FILTER (WHERE source='supervisor_revise') AS from_revise,
              COUNT(*) FILTER (WHERE source='manual_entry') AS from_manual,
              COALESCE(SUM(usage_count),0) AS total_usage FROM crm_ai_training_examples`);
    res.json({ items: rows, stats: stats.rows[0] });
  } catch (e) { next(e); }
});
router.post('/training-examples', async (req, res, next) => {
  try {
    const { case_pattern, category, subtype, analysis, suggested_action, suggested_script } = req.body || {};
    if (!case_pattern || !category || !analysis) return res.status(400).json({ error: 'case_pattern, category, analysis required' });
    const { rows } = await pg.query(
      `INSERT INTO crm_ai_training_examples (case_pattern, category, subtype, analysis, suggested_action, suggested_script, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'manual_entry',$7) RETURNING id`,
      [case_pattern, category, subtype || null, analysis, suggested_action || null, suggested_script || null, req.staff.staff_id]);
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});
router.put('/training-examples/:id', async (req, res, next) => {
  try {
    const f = req.body || {};
    await pg.query(
      `UPDATE crm_ai_training_examples SET case_pattern=COALESCE($2,case_pattern), category=COALESCE($3,category),
         subtype=$4, analysis=COALESCE($5,analysis), suggested_action=$6, suggested_script=$7,
         active=COALESCE($8,active), updated_at=now() WHERE id=$1`,
      [req.params.id, f.case_pattern||null, f.category||null, f.subtype||null, f.analysis||null,
       f.suggested_action||null, f.suggested_script||null, typeof f.active==='boolean'?f.active:null]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/training-examples/:id', async (req, res, next) => {
  try { await pg.query(`UPDATE crm_ai_training_examples SET active=FALSE, updated_at=now() WHERE id=$1`, [req.params.id]); res.json({ ok: true }); }
  catch (e) { next(e); }
});

module.exports = router;
