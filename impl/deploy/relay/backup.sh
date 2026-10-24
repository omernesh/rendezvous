#!/usr/bin/env bash
# Online LMDB export (no downtime) -> dated gzip on the NAS, keep 7.
set -euo pipefail
DEST=<backup-dir>
mkdir -p "$DEST"
OUT="$DEST/strfry-$(date +%Y%m%d-%H%M%S).jsonl.gz"
docker exec rendezvous-relay /app/strfry export | gzip > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
ls -1t "$DEST"/strfry-*.jsonl.gz | tail -n +8 | xargs -r rm -f
echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
