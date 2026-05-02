#!/usr/bin/env bash
# Nightly DB + uploads backup for crm-pilot. Keeps 14 daily snapshots.
set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/crm}"
DAY="$(date +%Y-%m-%d)"
DIR="$BACKUP_ROOT/$DAY"
mkdir -p "$DIR"

# PG credentials read from env (.env loaded by the cron entry)
: "${PG_DUMP_HOST:=localhost}"
: "${PG_DUMP_USER:=vonage_sync}"
: "${PG_DUMP_DB:=vonage_reports}"

echo "[backup $DAY] pg_dump (crm_* + persona/settings tables)..."
PGPASSWORD="${PG_DUMP_PASSWORD:-}" pg_dump \
  -h "$PG_DUMP_HOST" -U "$PG_DUMP_USER" -d "$PG_DUMP_DB" \
  -t 'crm_*' \
  -F c -Z 9 \
  -f "$DIR/crm_pg.dump"

echo "[backup $DAY] uploads/..."
if [ -d /home/krttpt/crm/uploads ]; then
  tar -czf "$DIR/uploads.tar.gz" -C /home/krttpt/crm uploads
fi

# Retention: keep 14 newest day directories, delete the rest
echo "[backup $DAY] retention..."
ls -1dt "$BACKUP_ROOT"/20*-*-* 2>/dev/null | tail -n +15 | xargs -r rm -rf

echo "[backup $DAY] done → $DIR"
