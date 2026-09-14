#!/bin/sh
# Consistent online SQLite backup with rotation.
# In Docker:   docker compose exec -T app sh scripts/backup.sh
# Host cron:   15 3 * * * cd /opt/throwaway-mail && docker compose exec -T app sh scripts/backup.sh >> /var/log/throwaway-backup.log 2>&1
set -eu
DATA_DIR="${DATA_DIR:-./data}"
DB="${DATABASE_PATH:-$DATA_DIR/throwaway.db}"
DEST="${BACKUP_DIR:-$DATA_DIR/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

[ -f "$DB" ] || { echo "database not found: $DB" >&2; exit 1; }
mkdir -p "$DEST"
STAMP=$(date -u +%Y%m%d-%H%M%S)
OUT="$DEST/throwaway-$STAMP.db"

sqlite3 "$DB" ".backup '$OUT'"
CHECK=$(sqlite3 "$OUT" "PRAGMA integrity_check;")
if [ "$CHECK" != "ok" ]; then
  echo "integrity check failed for $OUT: $CHECK" >&2
  rm -f "$OUT"
  exit 1
fi
gzip -9 "$OUT"

# Keep KEEP_DAYS days of backups
find "$DEST" -name 'throwaway-*.db.gz' -type f -mtime +"$((KEEP_DAYS - 1))" -delete
echo "$(date -u +%FT%TZ) backup ok: $OUT.gz ($(du -h "$OUT.gz" | cut -f1))"
