#!/usr/bin/env sh
set -eu

APP_DIR="${APP_DIR:-/opt/volunteer-system}"
BASE_URL="${BASE_URL:-http://127.0.0.1:${WEB_PORT:-8080}}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_SLEEP="${HEALTH_SLEEP:-2}"

check_url() {
  name="$1"
  url="$2"
  attempt=1
  while ! curl -fsS "$url" >/dev/null 2>&1; do
    if [ "$attempt" -ge "$HEALTH_RETRIES" ]; then
      echo "health check failed: $name $url" >&2
      return 1
    fi
    attempt=$((attempt + 1))
    sleep "$HEALTH_SLEEP"
  done
  echo "health check passed: $name"
}

cd "$APP_DIR"

npm --prefix frontend-query install
npm --prefix frontend-query run build
npm --prefix frontend-admin install
npm --prefix frontend-admin run build
npm --prefix backend install --production

docker compose up -d postgres redis
sh scripts/migrate-db.sh

docker compose up -d --build --remove-orphans
docker compose up -d --no-deps --force-recreate nginx

check_url "query" "$BASE_URL/query/"
check_url "admin" "$BASE_URL/admin/"
check_url "health" "$BASE_URL/health"
docker compose ps
