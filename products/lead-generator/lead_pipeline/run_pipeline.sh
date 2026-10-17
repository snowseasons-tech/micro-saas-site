#!/usr/bin/env bash
# =============================================================================
# run_pipeline.sh - nightly lead-gen chain
#
#   1. company_web_search.py   search new companies from the queue file
#   2. build_leads.py          promote results to leads, pick domain/phone/etc.
#   3. scrape_contacts.py      pull emails + names from lead websites
#
# Queue model: put new company names in companies_queue.txt (one per line,
# '#' for comments). After a clean search they move to companies_done.txt, so
# each night only NEW names are searched. Steps 2 and 3 are incremental too.
#
# Usage:
#   ./run_pipeline.sh                  run everything
#   ./run_pipeline.sh --dry-run        show what would run, change nothing
#   ./run_pipeline.sh --skip scrape    skip a step (search | build | scrape)
#
# Cron (nightly 2:15am; the script logs to logs/, cron mails only on failure):
#   MAILTO=you@example.com
#   15 2 * * * /path/to/project/run_pipeline.sh
#
# Needs Linux `flock` and `timeout` (util-linux / coreutils, standard).
# =============================================================================
set -uo pipefail

PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$PROJECT_DIR" || exit 2

# ---- settings (edit here or override with environment variables) ------------
QUEUE_FILE="${QUEUE_FILE:-$PROJECT_DIR/companies_queue.txt}"
DONE_FILE="${DONE_FILE:-$PROJECT_DIR/companies_done.txt}"
LOG_DIR="${LOG_DIR:-$PROJECT_DIR/logs}"
LOCK_FILE="${LOCK_FILE:-$PROJECT_DIR/.pipeline.lock}"
MAX_RESULTS="${MAX_RESULTS:-10}"     # results per search query
SEARCH_DELAY="${SEARCH_DELAY:-2}"    # base seconds between searches
SCRAPE_LIMIT="${SCRAPE_LIMIT:-50}"   # max websites scraped per night
SCRAPE_DELAY="${SCRAPE_DELAY:-1.5}"  # seconds between requests to one site
STEP_TIMEOUT="${STEP_TIMEOUT:-3h}"   # kill any single step after this long
KEEP_LOG_DAYS="${KEEP_LOG_DAYS:-30}"
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"   # cron's PATH is minimal

if [[ -x "$PROJECT_DIR/.venv/bin/python" ]]; then
    PY="$PROJECT_DIR/.venv/bin/python"
else
    PY="$(command -v python3)"
fi

# ---- arguments ---------------------------------------------------------------
DRY=0
SKIP=" "
while [[ $# -gt 0 ]]; do
    case "$1" in
        -n|--dry-run) DRY=1 ;;
        --skip)       SKIP+="${2:-} "; shift ;;
        -h|--help)    sed -n '2,23p' "${BASH_SOURCE[0]}"; exit 0 ;;
        *)            echo "Unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done
skipped() { [[ "$SKIP" == *" $1 "* ]]; }

# ---- single instance ---------------------------------------------------------
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    echo "run_pipeline.sh: previous run is still active - not starting another" >&2
    exit 1
fi

# ---- logging -----------------------------------------------------------------
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/pipeline_$(date +%F_%H%M%S).log"
exec 3>&2                                  # keep real stderr for failure alerts
if [[ -t 1 ]]; then
    exec > >(tee -a "$LOG") 2>&1           # interactive: screen + log
else
    exec >>"$LOG" 2>&1                     # cron: log only
fi
log() { printf '%s  %s\n' "$(date '+%F %T')" "$*"; }

FAILED=()

run_step() {  # run_step NAME COMMAND [ARGS...]
    local name="$1"; shift
    if skipped "$name"; then log "SKIP  $name"; return 0; fi
    log "START $name"
    if (( DRY )); then log "      would run: $*"; return 0; fi
    local t0=$SECONDS rc
    timeout "$STEP_TIMEOUT" "$@"
    rc=$?
    if   (( rc == 0 ));   then log "OK    $name ($((SECONDS - t0))s)"
    elif (( rc == 124 )); then log "FAIL  $name: timed out after $STEP_TIMEOUT"; FAILED+=("$name")
    else                       log "FAIL  $name: exit code $rc";                  FAILED+=("$name")
    fi
    return "$rc"
}

search_step() {
    skipped search && { log "SKIP  search"; return 0; }
    local snap tmp
    snap="$(mktemp)"
    grep -vE '^[[:space:]]*(#|$)' "$QUEUE_FILE" > "$snap" 2>/dev/null || true
    if [[ ! -s "$snap" ]]; then
        log "search: queue empty ($QUEUE_FILE) - nothing new to search"
        rm -f "$snap"
        return 0
    fi
    log "search: $(wc -l < "$snap") queued companies"
    if run_step search "$PY" -u company_web_search.py --file "$snap" \
            --max-results "$MAX_RESULTS" --delay "$SEARCH_DELAY"; then
        if (( ! DRY )); then
            cat "$snap" >> "$DONE_FILE"
            tmp="$(mktemp)"
            grep -vxFf "$snap" "$QUEUE_FILE" > "$tmp" || true   # keep names added mid-run
            mv "$tmp" "$QUEUE_FILE"
            log "search: moved processed names to $(basename "$DONE_FILE")"
        fi
    fi
    rm -f "$snap"
}

# ---- the chain ---------------------------------------------------------------
log "=== lead pipeline start (python: $PY) ==="
search_step
run_step build  "$PY" -u build_leads.py
run_step scrape "$PY" -u scrape_contacts.py --limit "$SCRAPE_LIMIT" --delay "$SCRAPE_DELAY"

find "$LOG_DIR" -name 'pipeline_*.log' -mtime +"$KEEP_LOG_DAYS" -delete 2>/dev/null

if (( ${#FAILED[@]} > 0 )); then
    msg="Lead pipeline FAILED step(s): ${FAILED[*]}  (log: $LOG)"
    log "=== $msg ==="
    echo "$msg" >&3                         # reaches cron's MAILTO
    exit 1
fi
log "=== lead pipeline finished OK ==="
