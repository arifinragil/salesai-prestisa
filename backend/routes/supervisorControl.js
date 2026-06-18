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

module.exports = router;
