// backend/cron_analyst_tier_a_prewarm.js
// Nightly pre-warm Tier A analyst report for leads active in the last 7 days.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const pg = require('./db/postgres');
const lotusPg = require('./db/lotus');
const { runTierA } = require('./services/analystReport');

const CONCURRENCY = 6;
const SLEEP_MS = 600;
const SAFETY_LIMIT = 1000;
const WARN_THRESHOLD = 300;
const MAX_TRANSCRIPT_MSGS = 80;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

async function findTargets() {
  const cands = (await lotusPg.query(`
    SELECT c.lotus_id, c.cust_number, c.business_number
      FROM contacts c
     WHERE c.last_message_at::date >= (now()::date - 7)
       AND (SELECT COUNT(*) FROM messages m
             WHERE m.cust_number = c.cust_number
               AND m.business_number = c.business_number
               AND m.direction = 'inbound') >= 4
  `)).rows;
  if (!cands.length) return { total: 0, todo: [] };
  const ids = cands.map(r => r.lotus_id);
  const done = new Set(
    (await pg.query(
      `SELECT lotus_id FROM crm_lotus_state
        WHERE lotus_id = ANY($1::text[]) AND analyst_report_generated_at IS NOT NULL AND stuck_group IS NOT NULL`,
      [ids]
    )).rows.map(r => r.lotus_id)
  );
  const todo = cands.filter(r => !done.has(r.lotus_id));
  return { total: cands.length, todo };
}

async function loadTranscript(custNumber, businessNumber) {
  const rows = (await lotusPg.query(
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

(async () => {
  const startedAt = Date.now();
  const { total, todo } = await findTargets();
  console.log(`Total candidates: ${total} · Need processing: ${todo.length}`);

  if (!todo.length) { process.exit(0); }

  if (todo.length > WARN_THRESHOLD) {
    console.warn(`WARN: backlog ${todo.length} exceeds threshold ${WARN_THRESHOLD}`);
  }

  const targets = todo.slice(0, SAFETY_LIMIT);
  if (todo.length > SAFETY_LIMIT) {
    console.warn(`WARN: capping to SAFETY_LIMIT=${SAFETY_LIMIT} (todo=${todo.length})`);
  }

  const corrections = (await pg.query(
    `SELECT corrected_root_cause AS to, corrected_reason AS reason FROM crm_lead_supervisor_actions
     WHERE action='revise_ai' AND corrected_root_cause IS NOT NULL ORDER BY created_at DESC LIMIT 15`
  )).rows;

  let done = 0, failed = 0, tokensIn = 0, tokensOut = 0;

  for (const batch of chunk(targets, CONCURRENCY)) {
    await Promise.all(batch.map(async (c) => {
      try {
        const { transcript, msgCount, inboundCount } = await loadTranscript(c.cust_number, c.business_number);
        if (inboundCount < 4) return;
        const { validated, usage } = await runTierA({ transcript, msgCount, inboundCount, geminiKey: process.env.GEMINI_API_KEY, corrections });
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
          [c.lotus_id, validated.customer_reason,
           validated.lead_status, validated.funnel_stage_lost, validated.customer_intent, validated.no_response_after,
           validated.controllability, validated.decision_maker, validated.internal_root_cause_categories,
           validated.sales_handling, validated.product_solution_fit, validated.confidence, validated.evidence_quote,
           validated.stuck_group, validated.stuck_issue,
           msgCount]
        );
        tokensIn += usage.input_tokens || 0;
        tokensOut += usage.output_tokens || 0;
        done++;
      } catch (e) {
        failed++;
        console.error(`\nfail ${c.lotus_id}: ${e.message}`);
      }
    }));
    process.stdout.write(`\rprogress: done=${done} failed=${failed} / ${targets.length}`);
    await sleep(SLEEP_MS);
  }
  const dur = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(`\n\nFinished in ${dur}s. Done=${done} Failed=${failed} Tokens in=${tokensIn} out=${tokensOut}`);
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
