#!/usr/bin/env sh
set -eu

if [ "${ALLOW_RESTORE:-}" != "1" ]; then
  echo "Refusing restore. Set ALLOW_RESTORE=1 after taking/confirming a backup." >&2
  exit 2
fi

if [ $# -ne 1 ]; then
  echo "Usage: ALLOW_RESTORE=1 scripts/restore-postgres.sh <dump-file>" >&2
  exit 2
fi

COMPOSE_DIR="${COMPOSE_DIR:-$(pwd)}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-volunteer_db}"
DUMP_FILE="$1"

if [ ! -f "$DUMP_FILE" ]; then
  echo "Dump file not found: $DUMP_FILE" >&2
  exit 2
fi

cd "$COMPOSE_DIR"

docker compose exec -T "$POSTGRES_SERVICE" pg_restore -l < "$DUMP_FILE" >/dev/null
docker compose exec -T "$POSTGRES_SERVICE" pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  -U "$DB_USER" \
  -d "$DB_NAME" < "$DUMP_FILE"

docker compose exec -T "$POSTGRES_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT COUNT(*) AS volunteer_logs FROM volunteer_logs;"
