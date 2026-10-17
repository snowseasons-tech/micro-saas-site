#!/usr/bin/env bash
# Scheduler wrapper for blogen: lockfile, logging, optional cron install.
#   ./run.sh [blogen args...]        e.g. ./run.sh --publish ghost
#   ./run.sh --install-cron "0 7 * * 1" [blogen args...]
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
mkdir -p logs

if [[ "${1:-}" == "--install-cron" ]]; then
  schedule="${2:?cron schedule required, e.g. \"0 7 * * 1\"}"; shift 2
  line="$schedule $(pwd)/run.sh $* >> $(pwd)/logs/cron.log 2>&1"
  ( crontab -l 2>/dev/null | grep -vF "$(pwd)/run.sh" || true; echo "$line" ) | crontab -
  echo "Installed: $line"; exit 0
fi

[[ -f .env ]] && set -a && source .env && set +a   # WP_USER, WP_APP_PASSWORD, GHOST_ADMIN_KEY

exec 9>.blogen.lock
flock -n 9 || { echo "blogen already running, exiting" >&2; exit 0; }

log="logs/$(date +%F_%H%M%S).log"
# Hard cap on the whole run so a stalled site can't hold the lock forever (exit 124 = timed out).
if timeout "${BLOGEN_TIMEOUT:-2h}" node blogen.mjs "$@" >"$log" 2>&1; then
  echo "ok: $log"
else
  rc=$?; echo "FAILED (rc=$rc): $log" >&2; tail -n 20 "$log" >&2; exit "$rc"
fi
find logs -name '*.log' -mtime +30 -delete
