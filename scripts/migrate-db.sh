#!/usr/bin/env sh
set -eu

COMPOSE_DIR="${COMPOSE_DIR:-$(pwd)}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-volunteer_db}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$COMPOSE_DIR/backend/src/db/migrations}"

cd "$COMPOSE_DIR"

docker compose exec -T "$POSTGRES_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT now()
);
SQL

for migration in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$migration" ] || continue
  version="$(basename "$migration")"
  applied="$(docker compose exec -T "$POSTGRES_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -t -A -c "SELECT 1 FROM schema_migrations WHERE version = '$version'")"
  if [ "$applied" = "1" ]; then
    echo "skip $version"
    continue
  fi

  if [ "$version" = "001_init.sql" ]; then
    has_users="$(docker compose exec -T "$POSTGRES_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -t -A -c "SELECT to_regclass('public.users') IS NOT NULL")"
    if [ "$has_users" = "t" ]; then
      docker compose exec -T "$POSTGRES_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c "INSERT INTO schema_migrations(version) VALUES ('$version') ON CONFLICT DO NOTHING"
      echo "mark existing $version"
      continue
    fi
  fi

  echo "apply $version"
  docker compose exec -T "$POSTGRES_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$migration"
  docker compose exec -T "$POSTGRES_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c "INSERT INTO schema_migrations(version) VALUES ('$version')"
done
