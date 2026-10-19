#!/usr/bin/env bash
set -euo pipefail
umask 077

sha="${1:?Usage: deploy-production.sh <merged main SHA>}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
app="${APP_DIR:-/opt/volunteer-system}"
releases="${RELEASES_DIR:-/opt/volunteer-system-release-backups}"
base_url="${BASE_URL:-http://127.0.0.1:8080}"
public_url="${PUBLIC_URL:-https://zysc.hanyao.me}"
runtime=(backend frontend-query frontend-admin frontend-status nginx scripts deploy
  docker-compose.yml docker-compose.override.yml .github)
cd "$app"
test "$(git branch --show-current)" = main
test "$(git rev-parse refs/remotes/origin/main)" = "$sha"
previous="$(git rev-parse HEAD)"
git merge-base --is-ancestor "$previous" "$sha"
git diff --quiet --cached || { echo 'Deployment blocked: the production Git index has staged changes.' >&2; exit 1; }
git diff --quiet -- "${runtime[@]}" || { echo 'Deployment blocked: production runtime source has local changes.' >&2; exit 1; }
test -z "$(git ls-files --others --exclude-standard -- "${runtime[@]}")" || {
  echo 'Deployment blocked: production runtime directories contain untracked source files.' >&2
  exit 1
}
test -s .env
mkdir -p "$releases"
release="$(mktemp -d "$releases/$(date -u +%Y%m%dT%H%M%SZ)-auto-${sha:0:8}.XXXXXX")"
source_dir="$release/source"
mkdir "$source_dir"
log="$release/deploy.log"
touch "$log"
switched=0
old_image="$(docker inspect volunteer-backend --format '{{.Image}}')"
candidate="volunteer-system-backend:deploy-$sha"
printf '%s\n' "$previous" > "$release/previous-commit"
printf '%s\n' "$old_image" > "$release/previous-image"
if [[ -f .release-version.json ]]; then cp .release-version.json "$release/previous-version.json"; fi

run() { "$@" >>"$log" 2>&1; }
with_password() (
  set -a
  # The existing server-owned file is never copied to the build directory or runner.
  . "$app/.env"
  set +a
  : "${DB_PASSWORD:?DB_PASSWORD is required for encrypted release backups}"
  export DB_PASSWORD
  "$@"
)
check_url() {
  local url="$1" attempt
  for attempt in {1..30}; do
    if curl --fail --silent --show-error --connect-timeout 3 --max-time 10 \
      "$url" >>"$log" 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}
rollback() {
  run git reset --merge "$previous" || return 1
  run docker image tag "$old_image" volunteer-system-backend:latest || return 1
  with_password openssl enc -d -aes-256-cbc -pbkdf2 -pass env:DB_PASSWORD \
    -in "$release/runtime.tar.gz.enc" | tar -xzf - -C "$app" >>"$log" 2>&1 || return 1
  if [[ -f "$release/previous-version.json" ]]; then
    run cp "$release/previous-version.json" "$app/.release-version.json" || return 1
  else
    run rm -f "$app/.release-version.json" || return 1
  fi
  run docker compose up -d postgres redis || return 1
  run docker compose up -d --no-build --no-deps --force-recreate backend nginx || return 1
  check_url "$base_url/health" || return 1
  echo 'Previous code and image restored. Database backup retained for manual recovery.'
}
finish() {
  local status=$?
  trap - EXIT
  if (( status != 0 )); then
    echo "Deployment failed; private server log: $log" >&2
    if (( switched )); then
      if ! rollback; then
        echo "Automatic code rollback failed; inspect $release on the server." >&2
      fi
    fi
  fi
  exit "$status"
}
trap finish EXIT

echo "Building and testing $sha on the server."
git archive "$sha" | tar -xf - -C "$source_dir"
for frontend in frontend-query frontend-admin; do
  run npm --prefix "$source_dir/$frontend" ci --no-audit --no-fund
  run npm --prefix "$source_dir/$frontend" run build
  chmod -R a+rX "$source_dir/$frontend/dist"
done
run docker build --label "org.opencontainers.image.revision=$sha" \
  -t "$candidate" "$source_dir/backend"
# The product regression imports a repository tool outside the packaged backend.
run docker run --rm --network none -e DATABASE_URL= -e REDIS_URL= \
  --mount "type=bind,src=$source_dir/tools,dst=/tools,readonly" \
  "$candidate" sh -c 'ln -s /app /backend && npm test'

echo 'Saving and verifying encrypted database and runtime backups.'
# Do not include .github: it may not exist before the first deployment.
tar --exclude=node_modules --exclude='.env*' -czf - \
  backend frontend-query frontend-admin frontend-status nginx scripts deploy \
  docker-compose.yml docker-compose.override.yml |
  with_password openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:DB_PASSWORD \
    -out "$release/runtime.tar.gz.enc"
with_password bash -c 'set -euo pipefail
  docker exec volunteer-db pg_dump -U "${DB_USER:-postgres}" -d "${DB_NAME:-volunteer_db}" -Fc |
    openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:DB_PASSWORD -out "$1"
  openssl enc -d -aes-256-cbc -pbkdf2 -pass env:DB_PASSWORD -in "$1" |
    docker exec -i volunteer-db pg_restore --file=/dev/null
' bash "$release/database.dump.enc" >>"$log" 2>&1
with_password openssl enc -d -aes-256-cbc -pbkdf2 -pass env:DB_PASSWORD \
  -in "$release/runtime.tar.gz.enc" | tar -tzf - >/dev/null
run docker image tag "$old_image" "volunteer-system-backend:rollback-$(basename "$release")"

echo 'Switching production services.'
run git merge --ff-only "$sha"
switched=1
run docker compose config --quiet
run docker image tag "$candidate" volunteer-system-backend:latest
run docker compose up -d postgres redis
for frontend in frontend-query frontend-admin; do
  # Retain old hashed assets for browsers with an already-open page.
  run rsync -a "$source_dir/$frontend/dist/" "$app/$frontend/dist/"
done
# The backend runs its ordered, locked migrations before accepting requests.
run docker compose up -d --no-build --no-deps --force-recreate backend nginx
for path in health query/ admin/ status/; do check_url "$base_url/$path"; done
for path in health query/ admin/ status/; do check_url "$public_url/$path?deploy=$sha"; done
test "$(docker inspect volunteer-backend --format '{{.Image}}')" = \
  "$(docker image inspect "$candidate" --format '{{.Id}}')"
python3 - "$app/.release-version.json" "$sha" "$candidate" "$release" <<'PY'
import datetime, json, os, sys
path, commit, image, backup = sys.argv[1:]
with open(path + '.tmp', 'w', encoding='utf-8') as output:
    json.dump(dict(commit=commit, image=image, backup=backup,
        deployed_at=datetime.datetime.now(datetime.timezone.utc).isoformat()), output, indent=2)
os.replace(path + '.tmp', path)
PY
echo "Production deployed successfully: $sha. Private release evidence: $release"
