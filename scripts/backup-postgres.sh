#!/usr/bin/env sh
set -eu

COMPOSE_DIR="${COMPOSE_DIR:-$(pwd)}"
load_env_file() {
  env_file="$1"
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
}

load_env_file "$COMPOSE_DIR/.env"
load_env_file "$COMPOSE_DIR/.supabase-backup.env"

POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-volunteer_db}"
BACKUP_DIR="${BACKUP_DIR:-$COMPOSE_DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PREFIX="${BACKUP_PREFIX:-volunteer_db}"
DUMP_FILE="$BACKUP_DIR/$PREFIX-$STAMP.dump"
MANIFEST_FILE="$BACKUP_DIR/$PREFIX-$STAMP.json"
LIST_FILE="$BACKUP_DIR/$PREFIX-$STAMP.list"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

cd "$COMPOSE_DIR"

docker compose exec -T "$POSTGRES_SERVICE" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$DUMP_FILE"
docker compose exec -T "$POSTGRES_SERVICE" pg_restore -l < "$DUMP_FILE" > "$LIST_FILE"
chmod 600 "$DUMP_FILE" "$LIST_FILE"

SIZE_BYTES="$(wc -c < "$DUMP_FILE" | tr -d ' ')"
SHA256="$(sha256sum "$DUMP_FILE" | awk '{print $1}')"

cat > "$MANIFEST_FILE" <<EOF_MANIFEST
{
  "database": "$DB_NAME",
  "compose_dir": "$COMPOSE_DIR",
  "postgres_service": "$POSTGRES_SERVICE",
  "created_at_utc": "$STAMP",
  "dump_file": "$(basename "$DUMP_FILE")",
  "list_file": "$(basename "$LIST_FILE")",
  "size_bytes": $SIZE_BYTES,
  "sha256": "$SHA256"
}
EOF_MANIFEST
chmod 600 "$MANIFEST_FILE"

if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ] && [ -n "${SUPABASE_BACKUP_BUCKET:-}" ]; then
  python3 "$COMPOSE_DIR/scripts/upload-to-supabase-storage.py" "$DUMP_FILE" "$MANIFEST_FILE" "$LIST_FILE"
fi

find "$BACKUP_DIR" -type f \( -name "$PREFIX-*.dump" -o -name "$PREFIX-*.json" -o -name "$PREFIX-*.list" \) -mtime +"$RETENTION_DAYS" -delete

printf '%s\n' "$MANIFEST_FILE"
