#!/bin/bash
# Launch a Playwright e2e run in its own Terminal.app window with live logs.
#
# Mandated protocol (2026-08-18): every run is confirmed with the user first, uses --workers=10,
# and happens in a visible terminal — never buried inside an agent's tool call.
#
#   scripts/e2e-run.sh api/plans.spec.ts ui/plans.spec.ts
#   WORKERS=6 scripts/e2e-run.sh api/testcases.spec.ts     # override only with a stated reason
#
# Writes a tee'd log to e2e/.run-logs/<timestamp>.log and prints the path so the run can be
# followed from elsewhere (tail -f) while the user watches the window.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E="$REPO/e2e"
WORKERS="${WORKERS:-10}"
API_BASE_URL="${API_BASE_URL:-http://localhost:1021}"
WEB_BASE_URL="${WEB_BASE_URL:-http://localhost:1020}"

if [ "$#" -eq 0 ]; then
  echo "error: name the impacted specs. A bare full-suite run must be asked for explicitly." >&2
  echo "usage: scripts/e2e-run.sh api/plans.spec.ts ui/plans.spec.ts [-g 'PL-01']" >&2
  exit 2
fi

# .auth/state.json is shared: a concurrent run rewrites it mid-flight and poisons both runs.
if pgrep -f "playwright test" >/dev/null 2>&1; then
  echo "error: a Playwright run is already in progress — it shares e2e/.auth/state.json." >&2
  echo "       Let it finish, or kill it, before starting another." >&2
  pgrep -fl "playwright test" | sed 's/^/       /' >&2
  exit 3
fi

# ── Image freshness ──────────────────────────────────────────────────────────
# The failure this exists to stop: on 2026-08-24 a 258-test run went red almost everywhere and every
# failure was a route or a label that simply was not in the running containers — images built seven
# hours earlier, before the code under test was written. A red run against stale images is worse than
# no run, because it reads exactly like a broken product.
#
# So: if any source file is newer than the image built from it, refuse and say what to do. Set
# ALLOW_STALE_IMAGES=1 to run anyway (testing something unrelated to the edits in the tree).
SRC_DIRS=(
  "$REPO/Tesbo-Backend-Nest/src" "$REPO/Tesbo-Backend-Nest/migrations"
  "$REPO/Tesbo-Frontend/app" "$REPO/Tesbo-Frontend/components" "$REPO/Tesbo-Frontend/lib"
)

image_epoch() {
  local iso
  iso="$(docker image inspect -f '{{.Created}}' "$1" 2>/dev/null || true)"
  [ -z "$iso" ] && return 1
  python3 -c "import sys,datetime;print(int(datetime.datetime.fromisoformat(sys.argv[1].split('.')[0].rstrip('Z')+'+00:00').timestamp()))" "$iso"
}

newest_source_epoch() {
  local newest=0 m
  for dir in "${SRC_DIRS[@]}"; do
    [ -d "$dir" ] || continue
    m="$(find "$dir" -type f -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/dist/*' \
      -exec stat -f '%m' {} + 2>/dev/null | sort -rn | head -1)"
    [ -n "$m" ] && [ "$m" -gt "$newest" ] && newest="$m"
  done
  echo "$newest"
}

if [ "${ALLOW_STALE_IMAGES:-0}" != "1" ]; then
  SRC_EPOCH="$(newest_source_epoch)"
  for img in tesbo-test-manager-private-backend tesbo-test-manager-private-frontend; do
    IMG_EPOCH="$(image_epoch "$img:latest" || echo 0)"
    if [ "$IMG_EPOCH" -eq 0 ]; then
      echo "error: no $img:latest image — build the stack first: scripts/deploy-and-test.sh $*" >&2
      exit 5
    fi
    if [ "$SRC_EPOCH" -gt "$IMG_EPOCH" ]; then
      echo "error: $img was built $(( (SRC_EPOCH - IMG_EPOCH) / 60 )) minute(s) BEFORE the newest source change." >&2
      echo "       Testing it would test code you are not running. Deploy first, then test:" >&2
      echo "         scripts/deploy-and-test.sh $*" >&2
      echo "       (ALLOW_STALE_IMAGES=1 to override, only when the change cannot affect this selection.)" >&2
      exit 6
    fi
  done
  echo "Images: backend + frontend are newer than every source file — safe to test."
fi

# Resolve the selection without executing anything, so the count can be checked before committing.
cd "$E2E"
SELECTED="$(API_BASE_URL="$API_BASE_URL" WEB_BASE_URL="$WEB_BASE_URL" \
  npx playwright test "$@" --list 2>/dev/null | tail -1)"
echo "Selection: $SELECTED"
case "$SELECTED" in
  *"Total: 0 "*|"") echo "error: selection resolved to 0 tests — that is a failed selection, not a pass." >&2; exit 4 ;;
esac

mkdir -p "$E2E/.run-logs"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$E2E/.run-logs/$STAMP.log"

# Hand Terminal a file rather than an escaped one-liner — no AppleScript quoting hazards.
LAUNCHER="$E2E/.run-logs/$STAMP.command"
{
  echo '#!/bin/bash'
  echo "cd $(printf '%q' "$E2E")"
  echo "echo '=== e2e run $STAMP — workers=$WORKERS ==='"
  echo "echo 'specs: $*'"
  echo "echo 'log:   $LOG'"
  echo "echo"
  printf 'API_BASE_URL=%q WEB_BASE_URL=%q npx playwright test' "$API_BASE_URL" "$WEB_BASE_URL"
  for a in "$@"; do printf ' %q' "$a"; done
  printf ' --workers=%q 2>&1 | tee %q\n' "$WORKERS" "$LOG"
  echo "echo"
  echo "echo '=== run finished — exit ${PIPESTATUS_PLACEHOLDER:-\$?} ==='"
} > "$LAUNCHER"
chmod +x "$LAUNCHER"

osascript >/dev/null <<APPLESCRIPT
tell application "Terminal"
  activate
  do script "$LAUNCHER"
  set custom title of front window to "e2e $STAMP (workers=$WORKERS)"
end tell
APPLESCRIPT

echo "Launched in a new Terminal window at --workers=$WORKERS."
echo "Log: $LOG"
