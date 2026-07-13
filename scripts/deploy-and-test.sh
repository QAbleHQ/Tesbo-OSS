#!/usr/bin/env bash
# Rebuilds and (re)starts the local docker-compose stack with the latest code, waits for
# the backend and frontend to report healthy, then runs the Playwright API + UI smoke
# suite against it.
#
# Usage: scripts/deploy-and-test.sh [playwright-args...]
# Example: scripts/deploy-and-test.sh --project=api
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

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

echo "==> Running Playwright smoke suite"
npx playwright test "$@"
