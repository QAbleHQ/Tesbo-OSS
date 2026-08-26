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

There's no API endpoint that returns a signup OTP. Outside production the backend runs with
`EMAIL_DELIVERY_MODE=log` (the default), which prints the code to the backend container's stdout and
never emails it — whether or not a `POSTMARK_API_TOKEN` is configured. So:

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

## Running against the stage environment

Stage is https://app-stage.tesbo.io with its API at https://api-app-stage.tesbo.io. The specs
themselves need no changes — the suite already targets whatever `API_BASE_URL` / `WEB_BASE_URL`
point at. Three things are different about a remote target, and `scripts/e2e-stage.sh` exists to
handle all three:

1. **Tenants must already exist.** `global-setup.ts` fails the whole run if it cannot log in as
   account A or account B. On a local stack it creates them by scraping the signup OTP out of
   `docker compose logs`; there is no container log to read on stage, so both accounts have to be
   signed up by hand first and their credentials put in `e2e/stage.env`.
2. **The SQL-fixture specs skip by default.** `utils/psql.ts` refuses to guess a database, so
   `dbControlAvailable()` is false and every suite that arranges state through SQL skips itself
   (~29 spec files). Setting `E2E_DATABASE_URL` to stage's own connection string unlocks them —
   the local postgres container is only transport for the `psql` binary, so a hosted URL is
   reachable — at the cost of real writes to the stage database. The runner requires
   `E2E_STAGE_DB_WRITES_ACK=yes` on top of it for that reason.
3. **Stage is shared.** Stripe write tests are refused outright, the local stack's `DATABASE_URL`
   and `STRIPE_*` are scrubbed from the environment so they cannot leak into a remote run, and the
   runner refuses any host that does not look like a stage host.

```bash
cp e2e/stage.env.example e2e/stage.env    # then fill in the stage accounts
scripts/e2e-stage.sh api/health.spec.ts api/testcases.spec.ts
```

It announces the selection and the suite total, refuses a 0-test selection, refuses to start while
another run holds `e2e/.auth/state.json`, and opens a Terminal window at `--workers=10` teeing to
`e2e/.run-logs/stage-<stamp>.log` — the same protocol as `scripts/e2e-run.sh`.

Note that `e2e/.auth/` is shared with local runs. Each run's global setup rewrites it, so they
self-heal in sequence, but never run a local suite and a stage suite at the same time.

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
