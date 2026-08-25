#!/bin/bash
# Run the Playwright e2e suite against a DEPLOYED environment, from a CI job.
#
# This is the headless sibling of scripts/e2e-run.sh and scripts/e2e-stage.sh. Those two are for a
# human at a Mac: they open a Terminal.app window with osascript and stream the run into it. Neither
# can work on a build agent, which is what this script exists for — no AppleScript, no Docker, no
# interactive confirmation, everything from the environment, and a non-zero exit on failure.
#
# THE POINT OF THIS SCRIPT is that pointing the suite at a different environment should be a matter
# of changing a URL. What used to stop that was the database transport: utils/psql.ts reached Postgres
# through `docker compose exec postgres psql`, which needs the compose stack on the same host, so on
# a build agent every DB-backed fixture skipped itself and 46 of 60 spec files went dark. psql.ts now
# connects directly, so a connection string is enough.
#
#   Required:
#     API_BASE_URL          https://api-app-stage.tesbo.io
#     WEB_BASE_URL          https://app-stage.tesbo.io
#     E2E_TEST_EMAIL        account A — must already exist on the target, or E2E_DATABASE_URL must be
#     E2E_TEST_PASSWORD     set so global-setup can create it
#
#   Strongly recommended:
#     E2E_DATABASE_URL      the target environment's own DATABASE_URL. Without it every spec that
#                           arranges state through SQL skips itself, and tenants must pre-exist.
#     E2E_TEST_EMAIL_B      account B, for the cross-tenant authorization suite. Auto-created when
#     E2E_TEST_PASSWORD_B   E2E_DATABASE_URL is set.
#
#   Optional:
#     E2E_WORKERS           default 10
#     E2E_ALLOW_PROD        "yes" to permit a production-looking host (refused otherwise)
#     E2E_SPECS             space-separated spec paths; default is the reported-ticket regressions
#
#   Usage:
#     scripts/e2e-ci.sh                              # the regression folder
#     scripts/e2e-ci.sh regression/ api/health.spec.ts
#     E2E_SPECS="api/ ui/" scripts/e2e-ci.sh         # everything

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E="$REPO/e2e"
WORKERS="${E2E_WORKERS:-10}"

die() { echo "error: $*" >&2; exit 1; }

# ─── Inputs ──────────────────────────────────────────────────────────────────
: "${API_BASE_URL:?set API_BASE_URL to the API origin of the target environment}"
: "${WEB_BASE_URL:?set WEB_BASE_URL to the web origin of the target environment}"
: "${E2E_TEST_EMAIL:?set E2E_TEST_EMAIL — account A must exist on the target, or set E2E_DATABASE_URL so it can be created}"
: "${E2E_TEST_PASSWORD:?set E2E_TEST_PASSWORD}"

api_host="${API_BASE_URL#*://}"; api_host="${api_host%%/*}"
web_host="${WEB_BASE_URL#*://}"; web_host="${web_host%%/*}"

# The suite creates, mutates and deletes real rows — that is what an end-to-end test does. Against
# production that is not a test run, it is an incident, and a copy-pasted job definition is exactly
# how it would happen. Refuse by default and make the override say what it is doing.
if [ "${E2E_ALLOW_PROD:-no}" != "yes" ]; then
  for h in "$api_host" "$web_host"; do
    case "$h" in
      *stage*|*staging*|*dev*|*test*|*qa*|localhost*|127.0.0.1*) ;;
      *) die "refusing to run against '$h': it does not look like a non-production host. This suite writes real data. Set E2E_ALLOW_PROD=yes only if that is genuinely intended." ;;
    esac
  done
fi

# Stripe writes create real Customers and permanently pin a workspace's billing currency, and a
# deployment's key is frequently a live one. Never from an unattended job.
[ "${E2E_BILLING_ALLOW_STRIPE_WRITES:-false}" != "true" ] \
  || die "E2E_BILLING_ALLOW_STRIPE_WRITES=true is refused in CI — a live key would create a real Stripe Customer."

# ─── Database transport ──────────────────────────────────────────────────────
#
# Pinned rather than probed. utils/psql.ts falls back to the Docker transport when a direct connection
# fails, which on an agent with no Docker turns a wrong connection string into 46 silently skipped
# spec files that still report success. Pinning "direct" makes that a loud failure instead.
if [ -n "${E2E_DATABASE_URL:-}" ]; then
  export E2E_DB_TRANSPORT=direct
  export E2E_AUTO_PROVISION="${E2E_AUTO_PROVISION:-true}"
  DB_NOTE="direct connection — SQL-backed fixtures ENABLED, tenants will be provisioned as needed"
else
  export E2E_AUTO_PROVISION="${E2E_AUTO_PROVISION:-false}"
  DB_NOTE="not configured — SQL-backed fixtures will SKIP, and every tenant must already exist"
fi

# A local stack's values must never leak into a run aimed somewhere else. utils/env.ts reads
# process.env.DATABASE_URL as a fallback, so an agent that sourced a .env for another purpose would
# point the fixtures at the wrong database while every assertion ran against the target.
unset DATABASE_URL STRIPE_WEBHOOK_SECRET STRIPE_SECRET_KEY \
      STRIPE_PRICE_ID_PRO_MONTHLY STRIPE_PRICE_ID_PRO_ANNUAL \
      STRIPE_PRICE_ID_PRO_MONTHLY_INR STRIPE_PRICE_ID_PRO_ANNUAL_INR || true

export API_BASE_URL WEB_BASE_URL CI=1

# ─── Dependencies ────────────────────────────────────────────────────────────
cd "$E2E"
[ -d node_modules ] || npm ci --no-audit --no-fund
# Chromium only — the ui project is the sole browser project (playwright.config.ts). --with-deps is
# what pulls the shared libraries a bare container lacks.
npx playwright install --with-deps chromium

# ─── Selection ───────────────────────────────────────────────────────────────
if [ "$#" -gt 0 ]; then
  SPECS=("$@")
else
  # shellcheck disable=SC2206
  SPECS=(${E2E_SPECS:-regression/})
fi

SELECTED="$(npx playwright test "${SPECS[@]}" --list 2>/dev/null | tail -1 || true)"
TOTAL="$(npx playwright test --list 2>/dev/null | tail -1 || true)"

echo "─────────────────────────────────────────────────────────────"
echo "Target:    $WEB_BASE_URL (api $API_BASE_URL)"
echo "Account A: $E2E_TEST_EMAIL"
echo "Database:  $DB_NOTE"
echo "Specs:     ${SPECS[*]}"
echo "Selection: $SELECTED"
echo "Suite:     $TOTAL"
echo "Workers:   $WORKERS"
echo "─────────────────────────────────────────────────────────────"

# A selection that resolved to nothing is a broken job definition, not a green run — a mistyped path
# would otherwise report success having tested nothing at all.
case "$SELECTED" in
  *"Total: 0 "*|"") die "selection resolved to 0 tests. That is a failed selection, not a pass." ;;
esac

# ─── Run ─────────────────────────────────────────────────────────────────────
mkdir -p .run-logs
export PLAYWRIGHT_JUNIT_OUTPUT_NAME="${PLAYWRIGHT_JUNIT_OUTPUT_NAME:-$E2E/.run-logs/junit.xml}"

# list for the console, junit for the CI test report, html for a browsable artifact.
set +e
npx playwright test "${SPECS[@]}" \
  --workers="$WORKERS" \
  --reporter=list,junit,html
STATUS=$?
set -e

echo
echo "JUnit:  $PLAYWRIGHT_JUNIT_OUTPUT_NAME"
echo "Report: $E2E/playwright-report/index.html"
[ "$STATUS" -eq 0 ] && echo "e2e: PASSED" || echo "e2e: FAILED (exit $STATUS)"
exit "$STATUS"
