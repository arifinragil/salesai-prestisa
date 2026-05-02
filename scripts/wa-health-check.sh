#!/usr/bin/env bash
# Daily WhatsApp send-health check. Detects rising fail rates that may signal
# the WA number is being throttled or heading toward a ban.
# Output: /home/krttpt/crm/logs/wa-health-YYYY-MM-DD.log
set -uo pipefail
set +e

cd /home/krttpt/crm
eval "$(grep -E '^PG_(HOST|PORT|DATABASE|USER|PASSWORD)=' .env | sed 's/=\(.*\)$/="\1"/')"
export PGPASSWORD="${PG_PASSWORD:-}"

LOG="/home/krttpt/crm/logs/wa-health-$(date +%F).log"
exec >"$LOG" 2>&1

psql_run() { psql -h "${PG_HOST:-localhost}" -U "${PG_USER:-vonage_sync}" -d "${PG_DATABASE:-vonage_reports}" -P pager=off "$@"; }

echo "════════════════════════════════════════════════════════════"
echo "  Tiara CRM — WA send health · $(date '+%Y-%m-%d %H:%M %Z')"
echo "════════════════════════════════════════════════════════════"

echo
echo "── Send stats (last 24h) ─────────────────────────────────────"
psql_run -c "
SELECT
  COUNT(*) FILTER (WHERE direction='out')                               AS sent,
  COUNT(*) FILTER (WHERE direction='out' AND send_status='send_failed') AS failed,
  ROUND(100.0 * COUNT(*) FILTER (WHERE direction='out' AND send_status='send_failed')
              / NULLIF(COUNT(*) FILTER (WHERE direction='out'), 0), 2)  AS fail_rate_pct
FROM crm_messages
WHERE created_at > now() - interval '24 hours';"

echo
echo "── By WA session (last 24h) ──────────────────────────────────"
psql_run -c "
SELECT c.wa_session,
       COUNT(*) FILTER (WHERE m.direction='out')                               AS sent,
       COUNT(*) FILTER (WHERE m.direction='out' AND m.send_status='send_failed') AS failed,
       ROUND(100.0 * COUNT(*) FILTER (WHERE m.direction='out' AND m.send_status='send_failed')
                   / NULLIF(COUNT(*) FILTER (WHERE m.direction='out'), 0), 2)  AS fail_rate_pct
FROM crm_messages m
JOIN crm_conversations c ON c.id = m.conversation_id
WHERE m.created_at > now() - interval '24 hours'
GROUP BY c.wa_session ORDER BY sent DESC;"

echo
echo "── Suspect blocked conversations (≥2 failures in 24h) ────────"
psql_run -c "
SELECT c.id, c.phone, c.wa_session,
       COUNT(*) FILTER (WHERE m.send_status='send_failed') AS failures,
       COUNT(*) AS attempts,
       MAX(m.created_at)::timestamp(0) AS last_attempt
FROM crm_messages m
JOIN crm_conversations c ON c.id = m.conversation_id
WHERE m.direction='out' AND m.created_at > now() - interval '24 hours'
GROUP BY c.id, c.phone, c.wa_session
HAVING COUNT(*) FILTER (WHERE m.send_status='send_failed') >= 2
ORDER BY failures DESC LIMIT 15;"

echo
echo "── Rate-limit / opt-out hits (last 24h) ──────────────────────"
psql_run -c "
SELECT
  reason,
  COUNT(*) FILTER (WHERE detail ILIKE '%hourly_send_cap%') AS hourly_caps,
  COUNT(*) FILTER (WHERE detail ILIKE '%daily_send_cap%')  AS daily_caps,
  COUNT(*) FILTER (WHERE detail ILIKE '%opt-out%')         AS opt_outs,
  COUNT(*) AS total
FROM crm_handovers
WHERE created_at > now() - interval '24 hours'
  AND (detail ILIKE '%send_cap%' OR detail ILIKE '%opt-out%')
GROUP BY reason;"

echo
echo "── Quick verdict ─────────────────────────────────────────────"
RATE=$(psql_run -At -c "
SELECT COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE direction='out' AND send_status='send_failed')
              / NULLIF(COUNT(*) FILTER (WHERE direction='out'), 0), 2), 0)
FROM crm_messages WHERE created_at > now() - interval '24 hours';")
RATE=${RATE:-0}
echo "Fail rate 24h: ${RATE}%"
# Bash int compare doesn't do floats; strip decimals.
RATE_INT=${RATE%%.*}
RATE_INT=${RATE_INT:-0}
if [ "$RATE_INT" -ge 5 ]; then
  echo "🚨 CRITICAL — fail rate ≥ 5% — nomor kemungkinan diflag/diblok WhatsApp."
  echo "   Action: Pause AI sementara, cek WAHA log, pertimbangkan switch ke Meta Cloud API."
  EXIT=2
elif [ "$RATE_INT" -ge 1 ]; then
  echo "⚠ WARNING — fail rate ≥ 1% — pantau, jalankan warmup mode kalau nomor baru."
  EXIT=1
else
  echo "✅ HEALTHY — fail rate <1%, semua aman."
  EXIT=0
fi

echo
echo "════════════════════════════════════════════════════════════"
echo "  Done · $(date '+%H:%M:%S') · log: $LOG"
echo "════════════════════════════════════════════════════════════"
exit $EXIT
