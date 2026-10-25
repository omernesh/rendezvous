#!/usr/bin/env bash
# Online LMDB export (no downtime) -> dated gzip in $BACKUP_DIR, keep 7.
set -euo pipefail
# BACKUP_DIR comes from the environment or from .env next to this script.
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -z "${BACKUP_DIR:-}" ] && [ -f "$HERE/.env" ]; then
  BACKUP_DIR="$(sed -n 's/^BACKUP_DIR=//p' "$HERE/.env" | tail -n 1)"
fi
: "${BACKUP_DIR:?set BACKUP_DIR (environment or .env) to the backup directory}"
DEST="$BACKUP_DIR"
mkdir -p "$DEST"
OUT="$DEST/strfry-$(date +%Y%m%d-%H%M%S).jsonl.gz"
docker exec rendezvous-relay /app/strfry export | gzip > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
ls -1t "$DEST"/strfry-*.jsonl.gz | tail -n +8 | xargs -r rm -f
echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
