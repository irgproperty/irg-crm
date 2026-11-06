#!/usr/bin/env bash
# Usage: tools/load.sh <sql_dir> [--local|--remote]   (applies schema first when the DB is empty)
set -u
DIR=$1; MODE=${2:---local}
for f in "$DIR"/*.sql; do
  out=$(npx wrangler d1 execute irg-crm $MODE --file "$f" 2>&1)
  if echo "$out" | grep -q 'ERROR'; then echo "FAILED $f"; echo "$out" | grep -A3 ERROR | head -8; exit 1; fi
  echo "ok $f"
done
