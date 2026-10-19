#!/usr/bin/env bash
set -euo pipefail

app=/opt/volunteer-system
command="${SSH_ORIGINAL_COMMAND:-}"
if [[ "$command" == check ]]; then
  for tool in git docker node npm python3 openssl rsync curl tar flock; do
    command -v "$tool" >/dev/null
  done
  test -s "$app/.env"
  test "$(git -C "$app" branch --show-current)" = main
  docker compose --project-directory "$app" config --quiet
  curl --fail --silent --show-error --connect-timeout 3 --max-time 10 \
    http://127.0.0.1:8080/health >/dev/null
  printf 'Production connection and preflight passed; current commit: %s\n' \
    "$(git -C "$app" rev-parse HEAD)"
  exit 0
fi
if [[ ! "$command" =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  echo 'Only check or deploy <40-character SHA> is permitted.' >&2
  exit 64
fi
sha="${BASH_REMATCH[1]}"
exec 9>/var/lock/volunteer-production-deploy.lock
flock -w 1800 9
test "$(git -C "$app" remote get-url origin)" = \
  https://github.com/OwenChenhy/volunteer-hours-system.git
git -C "$app" fetch --no-tags origin main
latest="$(git -C "$app" rev-parse refs/remotes/origin/main)"
if [[ "$sha" != "$latest" ]]; then
  git -C "$app" merge-base --is-ancestor "$sha" "$latest"
  echo "Skipping superseded deployment $sha; main is now $latest."
  exit 0
fi
script="$(mktemp /run/volunteer-deploy.XXXXXX)"
trap 'rm -f -- "$script"' EXIT
git -C "$app" show "$sha:scripts/deploy-production.sh" > "$script"
bash "$script" "$sha"
