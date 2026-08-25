#!/usr/bin/env bash
# Deploy what is in the working tree, then test it. The only supported way to test new code.
#
# Rebuilds the images from the CURRENT tree (committed or not), restarts the stack, waits for the
# backend and frontend to report healthy, and then hands the run to scripts/e2e-run.sh — so the test
# phase gets the mandated protocol: its own Terminal window, --workers=10, a tee'd log, the
# concurrent-run guard and the zero-selection guard.
#
# Why the handoff instead of running Playwright here: this script used to call `npx playwright test`
# inline, which meant a deployed run had none of those protections, and the protocol-compliant path
# (e2e-run.sh) had no way to know the images were stale. On 2026-08-24 that gap produced a 258-test
# run whose 64 failures were all code missing from seven-hour-old images.
#
# Usage: scripts/deploy-and-test.sh api/reports.spec.ts ui/reports.spec.ts
#        scripts/deploy-and-test.sh --all          # rebuild, then the whole suite (say why)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Building latest images (backend, frontend, migrator)"
docker compose build backend frontend migrator

echo "==> Starting stack"
docker compose up -d

wait_healthy() {
  local service="$1"
  local timeout="${2:-120}"
  local elapsed=0
  echo "==> Waiting for ${service} to become healthy"
  while ! docker compose ps "$service" | grep -q "(healthy)"; do
    if [ "$elapsed" -ge "$timeout" ]; then
      echo "==> Timed out waiting for ${service} to become healthy" >&2
      docker compose logs --tail=100 "$service" >&2
      return 1
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
  echo "==> ${service} is healthy"
}

wait_healthy backend
wait_healthy frontend

cd "$ROOT_DIR/e2e"

if [ ! -d node_modules ]; then
  echo "==> Installing e2e dependencies"
  npm install --no-audit --no-fund
fi
npx playwright install chromium

cd "$ROOT_DIR"

if [ "$#" -eq 0 ]; then
  echo "==> Stack is deployed and healthy. No specs named, so nothing was run." >&2
  echo "    Name the impacted specs:  scripts/deploy-and-test.sh api/reports.spec.ts ui/reports.spec.ts" >&2
  echo "    Or the whole suite:       scripts/deploy-and-test.sh --all" >&2
  exit 0
fi

if [ "$1" = "--all" ]; then
  shift
  set -- "$@"
  echo "==> Full-suite run against the freshly deployed stack"
fi

echo "==> Handing the run to scripts/e2e-run.sh (own window, --workers=10, tee'd log)"
exec "$ROOT_DIR/scripts/e2e-run.sh" "$@"
