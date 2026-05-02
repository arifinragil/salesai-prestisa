// backend/services/scoreAggregator.js
// Computes the daily composite performance score per agent per day.
// See spec §5.2 for the formula.
const pg = require('../db/postgres');
const logger = require('./logger');

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function volumeFactor(n) {
  if (!n || n <= 0) return 0;
  return Math.min(1, n / 50);
}

/**
 * @param {Date|string} date — UTC date string 'YYYY-MM-DD' or Date object
 */
async function computeForDate(date) {
  const dateStr = (date instanceof Date)
    ? date.toISOString().slice(0, 10)
    : String(date).slice(0, 10);

  const r = await pg.query(
    `WITH active_staff AS (
       SELECT DISTINCT staff_id FROM crm_suggestion_log
       WHERE staff_id IS NOT NULL AND shown_at::date = $1
       UNION
       SELECT DISTINCT assigned_staff_id AS staff_id FROM crm_conversations
       WHERE assigned_staff_id IS NOT NULL AND last_message_at::date = $1
     ),
     sug AS (
       SELECT staff_id,
              COUNT(*)::int AS shown,
              SUM(CASE WHEN usage_type='raw' THEN 1 ELSE 0 END)::int AS used_raw,
              SUM(CASE WHEN usage_type='edited' THEN 1 ELSE 0 END)::int AS used_edited,
              SUM(CASE WHEN usage_type='manual' THEN 1 ELSE 0 END)::int AS manual_count,
              AVG(edit_distance)::numeric(4,3) AS avg_edit
       FROM crm_suggestion_log
       WHERE staff_id IS NOT NULL AND shown_at::date = $1
       GROUP BY staff_id
     ),
     conv_agg AS (
       SELECT assigned_staff_id AS staff_id,
              COUNT(DISTINCT id)::int AS handled,
              COUNT(DISTINCT id) FILTER (WHERE pipeline_stage = 'paid')::int AS won,
              COUNT(DISTINCT id) FILTER (WHERE pipeline_stage = 'lost')::int AS lost,
              SUM(CASE WHEN pipeline_stage = 'paid' THEN deal_value_idr ELSE 0 END) AS value_won,
              AVG(EXTRACT(EPOCH FROM (first_response_at - first_inbound_at)))::int AS avg_resp_sec
       FROM crm_conversations
       WHERE assigned_staff_id IS NOT NULL AND last_message_at::date = $1
       GROUP BY assigned_staff_id
     ),
     msg_agg AS (
       SELECT c.assigned_staff_id AS staff_id, COUNT(m.id)::int AS msgs
       FROM crm_messages m JOIN crm_conversations c ON c.id = m.conversation_id
       WHERE c.assigned_staff_id IS NOT NULL
         AND m.direction = 'out' AND m.sender_type = 'staff'
         AND m.created_at::date = $1
       GROUP BY c.assigned_staff_id
     ),
     csat_agg AS (
       SELECT c.assigned_staff_id AS staff_id,
              AVG(cs.score)::numeric(3,2) AS csat_avg,
              COUNT(*)::int AS csat_n
       FROM crm_csat cs JOIN crm_conversations c ON c.id = cs.conversation_id
       WHERE c.assigned_staff_id IS NOT NULL
         AND cs.collected_at::date = $1
       GROUP BY c.assigned_staff_id
     ),
     flags_agg AS (
       SELECT staff_id,
              SUM(CASE WHEN severity='high' THEN 1 ELSE 0 END)::int AS rf_high,
              SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END)::int AS rf_critical,
              SUM(CASE WHEN rule_id='missed_followup' THEN 1 ELSE 0 END)::int AS missed_n
       FROM crm_agent_red_flags
       WHERE detected_at::date = $1
       GROUP BY staff_id
     )
     SELECT s.staff_id,
            COALESCE(c.handled,0) AS conv_handled,
            COALESCE(m.msgs,0) AS msg_sent,
            c.avg_resp_sec AS avg_response_time_sec,
            COALESCE(sg.shown,0) AS sug_shown,
            COALESCE(sg.used_raw,0) AS sug_used_raw,
            COALESCE(sg.used_edited,0) AS sug_used_edited,
            COALESCE(sg.manual_count,0) AS sug_manual,
            sg.avg_edit AS avg_edit_distance,
            COALESCE(c.won,0) AS won, COALESCE(c.lost,0) AS lost,
            COALESCE(c.value_won,0) AS value_won,
            cs.csat_avg, COALESCE(cs.csat_n,0) AS csat_n,
            COALESCE(f.rf_high,0) AS rf_high, COALESCE(f.rf_critical,0) AS rf_critical,
            COALESCE(f.missed_n,0) AS missed_n
     FROM active_staff s
     LEFT JOIN sug sg ON sg.staff_id = s.staff_id
     LEFT JOIN conv_agg c ON c.staff_id = s.staff_id
     LEFT JOIN msg_agg m ON m.staff_id = s.staff_id
     LEFT JOIN csat_agg cs ON cs.staff_id = s.staff_id
     LEFT JOIN flags_agg f ON f.staff_id = s.staff_id`,
    [dateStr]
  );

  let written = 0;
  for (const row of r.rows) {
    const closed = row.won + row.lost;
    const conversionRate = closed > 0 ? row.won / closed : 0;
    const sugFactor = row.sug_shown > 0
      ? (row.sug_used_raw + 0.7 * row.sug_used_edited) / row.sug_shown
      : 0;

    let score =
        25 * conversionRate
      + 20 * (1 - clamp((row.avg_response_time_sec || 300) / 300, 0, 1))
      + 15 * ((row.csat_avg || 0) / 5)
      + 15 * sugFactor
      +  5 * volumeFactor(row.conv_handled)
      - 10 * row.rf_high
      - 25 * row.rf_critical
      - (row.missed_n > 2 ? 10 : 0);

    score = clamp(Math.round(score * 100) / 100, 0, 100);

    await pg.query(
      `INSERT INTO crm_agent_daily_scores
        (staff_id, date, conv_handled, msg_sent, avg_response_time_sec,
         suggestion_shown, suggestion_used_raw, suggestion_used_edited, suggestion_manual,
         avg_edit_distance, conv_closed_won, conv_closed_lost, total_value_won,
         conversion_rate, red_flags_high, red_flags_critical,
         csat_avg, csat_count, performance_score, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now())
       ON CONFLICT (staff_id, date) DO UPDATE SET
         conv_handled = EXCLUDED.conv_handled,
         msg_sent = EXCLUDED.msg_sent,
         avg_response_time_sec = EXCLUDED.avg_response_time_sec,
         suggestion_shown = EXCLUDED.suggestion_shown,
         suggestion_used_raw = EXCLUDED.suggestion_used_raw,
         suggestion_used_edited = EXCLUDED.suggestion_used_edited,
         suggestion_manual = EXCLUDED.suggestion_manual,
         avg_edit_distance = EXCLUDED.avg_edit_distance,
         conv_closed_won = EXCLUDED.conv_closed_won,
         conv_closed_lost = EXCLUDED.conv_closed_lost,
         total_value_won = EXCLUDED.total_value_won,
         conversion_rate = EXCLUDED.conversion_rate,
         red_flags_high = EXCLUDED.red_flags_high,
         red_flags_critical = EXCLUDED.red_flags_critical,
         csat_avg = EXCLUDED.csat_avg,
         csat_count = EXCLUDED.csat_count,
         performance_score = EXCLUDED.performance_score,
         computed_at = now()`,
      [row.staff_id, dateStr, row.conv_handled, row.msg_sent, row.avg_response_time_sec,
       row.sug_shown, row.sug_used_raw, row.sug_used_edited, row.sug_manual,
       row.avg_edit_distance, row.won, row.lost, row.value_won,
       conversionRate.toFixed(3), row.rf_high, row.rf_critical,
       row.csat_avg, row.csat_n, score]
    );
    written++;
  }
  logger.info({ date: dateStr, staff: r.rows.length, written }, '[scoreAggregator] done');
  return { staff: r.rows.length, written };
}

module.exports = { computeForDate };
