/**
 * Shared configuration for the k6 load suite.
 *
 * Every knob is an environment variable so a run can be retargeted without editing a script, and so
 * the same scripts can be pointed at staging first and production second with nothing but `-e`.
 *
 * The production-safety posture is deliberate and lives here rather than in each scenario:
 * these scripts WRITE (test cases, runs, executions) and they are meant to be pointed at
 * app.tesbo.io. Nothing may run until the caller has named a project id explicitly — there is no
 * default, no "first project I find", and no discovery step that could wander into a customer
 * workspace. See requireConfig().
 */

const DEFAULTS = {
  baseUrl: 'https://app.tesbo.io',
  caseCount: 5000,
  runCount: 10,
  // The repository table's own default page size (Tesbo-Frontend .../testcases/page.tsx
  // DEFAULT_PAGE_SIZE). Scenario 1 opens the screen the way a user does, so it pages at 25.
  pageSize: 25,
  // listTestCases() clamps `limit` to 500, and the UI's "select all" walks the repository at
  // exactly that ceiling to collect ids. Both numbers have to stay in step with the server.
  maxPageSize: 500,
  // bulkCreateTestCases() refuses a batch larger than MAX_BULK_TESTCASES (500), so seeding 5000
  // cases is 10 batches, not one request.
  bulkBatchSize: 500,
  vus: 50,
};

function num(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got "${raw}"`);
  return parsed;
}

function bool(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export const config = {
  baseUrl: (__ENV.BASE_URL || DEFAULTS.baseUrl).replace(/\/$/, ''),

  /*
   * A project-scoped API token (`tsbo_...`), minted at Project → Settings → API keys.
   *
   * Bearer auth is the right credential for a load test and a session cookie is the wrong one.
   * AuthMiddleware consults the bearer only when there is no valid session and then sets req.userId
   * for EVERY route, so a token exercises the same handlers the browser does — but without 50 VUs
   * hammering POST /api/auth/password/login, which is a real user-facing endpoint with its own
   * failure modes and is not what this test is measuring.
   */
  token: __ENV.TESBO_TOKEN || '',

  // No default, on purpose — see requireConfig().
  projectId: __ENV.PROJECT_ID || '',

  caseCount: num('CASE_COUNT', DEFAULTS.caseCount),
  runCount: num('RUN_COUNT', DEFAULTS.runCount),
  pageSize: num('PAGE_SIZE', DEFAULTS.pageSize),
  maxPageSize: num('MAX_PAGE_SIZE', DEFAULTS.maxPageSize),
  bulkBatchSize: num('BULK_BATCH_SIZE', DEFAULTS.bulkBatchSize),
  vus: num('VUS', DEFAULTS.vus),

  /*
   * How a run's cases are submitted: 'all' sends the whole selection in one POST (what the UI does
   * today), 'chunked' splits it into ADD_CHUNK_SIZE-sized POSTs.
   *
   * Worth having both. addCycleTestCases() is a single statement now, but it still runs under a 30s
   * statement_timeout and behind Cloudflare's 100s proxy limit, and the code comment on that method
   * records a production 524 from exactly this call. Comparing the two modes is how you find out
   * whether one-shot is still safe at 5000 after the infra upgrade.
   */
  addMode: __ENV.ADD_MODE || 'all',
  addChunkSize: num('ADD_CHUNK_SIZE', 1000),

  /*
   * Tag stamped into every fixture name so teardown can find exactly what this campaign created and
   * nothing else. Override it to group several runs under one label.
   */
  tag: __ENV.RUN_TAG || 'k6-load',

  // Guard rail: teardown.js refuses to delete anything unless this is explicitly true.
  confirmDelete: bool('CONFIRM_DELETE', false),

  // Set true to let seed.js reuse cases already present in the project instead of creating more.
  reuseExisting: bool('REUSE_EXISTING', true),

  /*
   * Stage durations for the ramping scenarios.
   *
   * Configurable so the same script serves three jobs: a 30-second smoke to prove the profile runs
   * before it is pointed at production (WARMUP=5s RAMP_UP=5s STEADY=10s RAMP_DOWN=5s), the ~9-minute
   * default campaign, and a long soak if one is wanted. Hard-coding them would have meant a separate
   * throwaway script for the smoke, which then drifts from the one that actually runs.
   */
  warmup: __ENV.WARMUP || '1m',
  rampUp: __ENV.RAMP_UP || '2m',
  steady: __ENV.STEADY || '5m',
  rampDown: __ENV.RAMP_DOWN || '1m',
};

export const headers = {
  Authorization: `Bearer ${config.token}`,
  'Content-Type': 'application/json',
};

/**
 * Fails fast, before any traffic, when the run is not safely configured.
 *
 * A load test that starts and *then* discovers it has no credential has already put load on
 * production to learn something a string check knew for free.
 */
export function requireConfig(opts = {}) {
  const missing = [];
  if (!config.token) missing.push('TESBO_TOKEN (a tsbo_... project API token)');
  if (opts.needsProject !== false && !config.projectId) missing.push('PROJECT_ID (the dedicated load-test project)');
  if (missing.length) {
    throw new Error(
      `Refusing to start. Missing required configuration:\n  - ${missing.join('\n  - ')}\n\n` +
        `These scripts write real data to ${config.baseUrl}. Point them at a project you created ` +
        `for load testing, never a customer workspace.`
    );
  }
}

/** One-line banner so a log or screenshot always records what was actually run. */
export function banner(name) {
  console.log(
    `[${name}] target=${config.baseUrl} project=${config.projectId} ` +
      `cases=${config.caseCount} runs=${config.runCount} vus=${config.vus} tag=${config.tag}`
  );
}
