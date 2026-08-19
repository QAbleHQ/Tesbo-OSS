#!/bin/bash
# Launch a k6 load scenario in its own Terminal.app window with live logs.
#
# Mirrors scripts/e2e-run.sh: a run that matters happens in a visible window and tees to a file,
# never buried inside an agent's tool call.
#
#   scripts/load-run.sh seed
#   scripts/load-run.sh s1-repository
#   VUS=50 scripts/load-run.sh s3-mixed-50vu
#   CONFIRM_DELETE=true scripts/load-run.sh teardown
#
# Credentials come from the environment (or load/.env, which is gitignored):
#   TESBO_TOKEN=tsbo_...      project API token
#   PROJECT_ID=<uuid>         the DEDICATED load-test project — never a customer's
#   BASE_URL=https://app.tesbo.io
#
# Writes a tee'd log and a machine-readable summary to load/.run-logs/<timestamp>.{log,json}.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOAD="$REPO/load"

if [ "$#" -eq 0 ]; then
  echo "error: name the scenario to run." >&2
  echo "usage: scripts/load-run.sh <seed|s1-repository|s2-run-build|s3-mixed-50vu|s4-breakpoint|teardown> [k6 args]" >&2
  exit 2
fi

SCENARIO="$1"; shift
SCRIPT_PATH="$LOAD/$SCENARIO.js"
[ -f "$SCRIPT_PATH" ] || { echo "error: no such scenario: $SCRIPT_PATH" >&2; exit 2; }

command -v k6 >/dev/null 2>&1 || {
  echo "error: k6 is not installed. brew install k6" >&2
  exit 127
}

# Optional local credential file, so tokens never have to be pasted into a shell history.
[ -f "$LOAD/.env" ] && set -a && . "$LOAD/.env" && set +a

BASE_URL="${BASE_URL:-https://app.tesbo.io}"
: "${TESBO_TOKEN:?set TESBO_TOKEN (a tsbo_... project API token)}"
: "${PROJECT_ID:?set PROJECT_ID (the dedicated load-test project id)}"

# Production writes get an explicit, typed confirmation. s1 and s4 are read-only and skip it.
case "$SCENARIO" in
  seed|s2-run-build|s3-mixed-50vu|teardown)
    if [[ "$BASE_URL" == *"app.tesbo.io"* ]]; then
      echo "=============================================================="
      echo " '$SCENARIO' WRITES DATA to PRODUCTION: $BASE_URL"
      echo " project: $PROJECT_ID"
      echo " Confirm this is a dedicated load-test project, not a customer's."
      echo "=============================================================="
      read -r -p "Type the project id to continue: " TYPED
      [ "$TYPED" = "$PROJECT_ID" ] || { echo "aborted." >&2; exit 3; }
    fi
    ;;
esac

mkdir -p "$LOAD/.run-logs"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$LOAD/.run-logs/$SCENARIO-$STAMP.log"
SUMMARY="$LOAD/.run-logs/$SCENARIO-$STAMP.json"

# Hand Terminal a file rather than an escaped one-liner — no AppleScript quoting hazards.
LAUNCHER="$LOAD/.run-logs/$SCENARIO-$STAMP.command"
{
  echo '#!/bin/bash'
  echo "cd $(printf '%q' "$LOAD")"
  echo "echo '=== k6 $SCENARIO — $STAMP ==='"
  echo "echo 'target:  $BASE_URL'"
  echo "echo 'project: $PROJECT_ID'"
  echo "echo 'log:     $LOG'"
  echo "echo"
  printf 'BASE_URL=%q TESBO_TOKEN=%q PROJECT_ID=%q' "$BASE_URL" "$TESBO_TOKEN" "$PROJECT_ID"
  for v in VUS CASE_COUNT RUN_COUNT PAGE_SIZE ADD_MODE ADD_CHUNK_SIZE BUILD_VUS PEAK_RPS RUN_TAG CONFIRM_DELETE REUSE_EXISTING WARMUP RAMP_UP STEADY RAMP_DOWN; do
    [ -n "${!v:-}" ] && printf ' %s=%q' "$v" "${!v}"
  done
  printf ' k6 run --summary-export=%q %q' "$SUMMARY" "$SCRIPT_PATH"
  for a in "$@"; do printf ' %q' "$a"; done
  printf ' 2>&1 | tee %q\n' "$LOG"
  echo "echo"
  echo "echo '=== finished — summary: $SUMMARY ==='"
  echo 'read -n 1 -s -r -p "Press any key to close."'
} > "$LAUNCHER"
chmod +x "$LAUNCHER"

open -a Terminal "$LAUNCHER"
echo "Launched '$SCENARIO' in a Terminal window."
echo "  log:     $LOG"
echo "  summary: $SUMMARY"
echo "  follow:  tail -f $LOG"
