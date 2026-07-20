# Tesbo E2E Smoke Suite

Playwright-based API + UI smoke tests that run against a **deployed** instance of Tesbo
(local docker-compose by default, or any environment via env vars). This is deliberately a
smoke suite, not full coverage: health check, login, and one create/read/update/delete pass
each for the API and the UI, enough to catch a broken deploy.

Wiring this into GitHub Actions on every PR is a separate, later piece of work — this suite
is meant to be run manually or from a post-deploy step for now.

## Running locally

From the repo root, after the docker-compose stack is up and healthy:

```
scripts/deploy-and-test.sh
```

This rebuilds the backend/frontend/migrator images, brings the stack up, waits for the
backend and frontend health checks, then runs the full suite.

To run the suite directly (stack already up):

```
cd e2e
npm install
npm run install-browsers   # once, downloads the Chromium binary
npm test                   # both projects
npm run test:api           # API tests only
npm run test:ui            # UI tests only
npm run report             # open the last HTML report
```

## How auth works in these tests

There's no API endpoint that returns a signup OTP — in dev (no `POSTMARK_API_TOKEN`
configured) the code is only printed to the backend container's stdout. So:

- `global-setup.ts` runs once before any test. It first tries `POST
  /api/auth/password/login` with the configured smoke-test credentials
  (`E2E_TEST_EMAIL`/`E2E_TEST_PASSWORD`, defaults in `.env.example`).
- If that fails and the target looks local (`API_BASE_URL` is localhost/127.0.0.1, or
  `E2E_AUTO_PROVISION=true` is set explicitly), it signs the user up via `/api/auth/signup/start`,
  scrapes the OTP out of `docker compose logs <service>`, and verifies it via
  `/api/auth/signup/verify`.
- It then ensures the user has a workspace + project (creating `E2E_ORG_NAME` /
  `E2E_PROJECT_NAME` if needed), and saves the authenticated session cookie to
  `.auth/state.json` plus `{ organizationId, projectId }` to `.auth/context.json` for every
  spec file to reuse.
- Against a remote target where you don't have docker log access, pre-create this user
  yourself and set `E2E_AUTO_PROVISION=false` (or just leave it unset — it already defaults
  to false for non-local hosts).

The seeded user and its "E2E Smoke Project" persist across runs (the docker volume isn't
wiped), so re-runs reuse the same account/project rather than accumulating new ones. Test
cases created by tests delete themselves at the end of the test.

## Config

Copy `.env.example` to `.env` and adjust if needed — every value has a working default for
the local stack. See that file for the full list (`API_BASE_URL`, `WEB_BASE_URL`,
`E2E_TEST_EMAIL`, etc).

## Layout

```
e2e/
  global-setup.ts     # provisions the smoke user + workspace/project, saves auth state
  playwright.config.ts
  api/                 # APIRequestContext-based tests, no browser
  ui/                  # browser-driven tests (chromium)
  utils/env.ts         # central env var + defaults
```
