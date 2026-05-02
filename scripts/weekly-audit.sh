#!/usr/bin/env bash
# Weekly audit for Tiara CRM. Run by /etc/cron.d/crm-pilot.
# Output: /home/krttpt/crm/logs/weekly-audit-YYYY-MM-DD.log
set -uo pipefail
# Continue past failures — most "errors" here are just empty dirs/logs.
set +e

cd /home/krttpt/crm
# Don't source the whole .env — MYSQL_PASSWORD contains backticks. Just grab PG vars.
eval "$(grep -E '^PG_(HOST|PORT|DATABASE|USER|PASSWORD)=' .env | sed 's/=\(.*\)$/="\1"/')"

LOG="/home/krttpt/crm/logs/weekly-audit-$(date +%F).log"
exec >"$LOG" 2>&1

echo "════════════════════════════════════════════════════════════"
echo "  Tiara CRM weekly audit — $(date '+%Y-%m-%d %H:%M %Z')"
echo "════════════════════════════════════════════════════════════"

# Use a function instead of a variable to avoid quote-mangling on the -F arg.
psql_run() { psql -h "${PG_HOST:-localhost}" -U "${PG_USER:-vonage_sync}" -d "${PG_DATABASE:-vonage_reports}" -P pager=off "$@"; }
PSQL="psql_run"
export PGPASSWORD="${PG_PASSWORD:-}"

section() { echo; echo "── $1 ─────────────────────────────────────────"; }

section "1. CSAT response rate (last 7 days)"
$PSQL -c "
WITH window_ AS (SELECT now() - interval '7 days' AS since)
SELECT
  (SELECT COUNT(*) FROM crm_messages m, window_
   WHERE m.created_at > since AND m.direction='out'
     AND m.body ILIKE '%rating pengalaman chat%') AS prompts_sent,
  (SELECT COUNT(*) FROM crm_csat, window_ WHERE collected_at > since) AS responses,
  (SELECT ROUND(AVG(score)::numeric, 2) FROM crm_csat, window_ WHERE collected_at > since) AS avg_score,
  (SELECT json_agg(json_build_object('score', score, 'n', n) ORDER BY score)
     FROM (SELECT score, COUNT(*) AS n FROM crm_csat, window_ WHERE collected_at > since GROUP BY score) t)
   AS distribution
;"

section "2. Backup nightly"
ls -lh /var/backups/crm/ 2>/dev/null | head -20 || echo "(no backups yet)"
echo
echo "Total snapshot dirs:"
ls -1d /var/backups/crm/20*-*-* 2>/dev/null | wc -l
echo
echo "Last 10 lines of cron-backup.log:"
tail -10 /home/krttpt/crm/logs/cron-backup.log 2>/dev/null || echo "(log empty)"

section "3. Daily rollup cron"
$PSQL -c "
SELECT date::date, total_inbound, total_ai_sent, total_handovers,
       cost_usd::numeric(10,4) AS cost_usd
FROM crm_ai_metrics_daily
WHERE date > current_date - interval '8 days'
ORDER BY date DESC;"
echo
echo "Last 10 lines of cron-rollup.log:"
tail -10 /home/krttpt/crm/logs/cron-rollup.log 2>/dev/null || echo "(log empty)"

section "4. Debounce health (last 7 days)"
$PSQL -c "
WITH q AS (
  SELECT status, COUNT(*) AS n
  FROM crm_inbound_queue
  WHERE created_at > now() - interval '7 days'
  GROUP BY status
)
SELECT status, n,
       ROUND(100.0 * n / NULLIF(SUM(n) OVER (), 0), 1) AS pct
FROM q ORDER BY n DESC;"
echo
echo "Conversations with most batched (skipped) inbound:"
$PSQL -c "
SELECT conversation_id, COUNT(*) AS skipped
FROM crm_inbound_queue
WHERE status='skipped' AND created_at > now() - interval '7 days'
GROUP BY conversation_id ORDER BY skipped DESC LIMIT 10;"

section "5. AI feedback signal (last 7 days)"
$PSQL -c "
SELECT
  SUM(CASE WHEN feedback = 1 THEN 1 ELSE 0 END) AS thumbs_up,
  SUM(CASE WHEN feedback = -1 THEN 1 ELSE 0 END) AS thumbs_down,
  COUNT(*) FILTER (WHERE feedback IS NOT NULL) AS total_rated
FROM crm_messages
WHERE feedback_at > now() - interval '7 days';"
echo
echo "Recent thumbs-down samples (most recent 5):"
$PSQL -c "
SELECT m.id, c.phone,
       LEFT(m.body, 120) AS body_preview,
       COALESCE(m.ai_metadata->>'tools_called','-') AS tools,
       to_char(m.feedback_at, 'YYYY-MM-DD HH24:MI') AS at
FROM crm_messages m JOIN crm_conversations c ON c.id = m.conversation_id
WHERE m.feedback = -1 AND m.feedback_at > now() - interval '7 days'
ORDER BY m.feedback_at DESC LIMIT 5;"

section "6. Eval runs (last 7 days)"
$PSQL -c "
SELECT id, ran_at::timestamp(0), total, passed,
       pass_rate AS pct
FROM crm_eval_runs
WHERE ran_at > now() - interval '7 days'
ORDER BY ran_at DESC;"

echo
echo "════════════════════════════════════════════════════════════"
echo "  Audit complete · $(date '+%H:%M:%S')"
echo "════════════════════════════════════════════════════════════"
