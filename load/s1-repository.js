/**
 * Scenario 1 — "how does the repository behave when it holds 5000 test cases?"
 *
 *   k6 run load/s1-repository.js -e TESBO_TOKEN=... -e PROJECT_ID=... -e VUS=50
 *
 * Read-only. It creates nothing and deletes nothing, which makes it the safe one to point at
 * production first and the one to re-run after every infra change.
 *
 * The iteration is the real screen, not a synthetic endpoint hammer. Opening the repository fires
 * four requests before the user has done anything (project, suite tree, summary tiles, first page),
 * and the page-size default is 25 — so measuring only `?limit=500` would report a number no user
 * ever waits for.
 *
 * Four distinct pressures are separated so the summary can tell you which one hurts:
 *
 *   op_repo_open_page      — the first page. What "the repository is slow" actually means.
 *   op_repo_page_deep      — offset ~4900. OFFSET makes Postgres walk and discard every skipped
 *                            row, so page 200 costs strictly more than page 1 on the same index.
 *                            If this diverges sharply from op_repo_open_page, keyset pagination is
 *                            the fix and no amount of extra hardware substitutes for it.
 *   op_repo_search         — LIKE '%term%' against the V82 trigram indexes (title, external_id,
 *                            description). Confirms the indexes are actually being chosen at this
 *                            row count rather than falling back to a sequential scan.
 *   op_repo_filter         — status/priority equality filters, which ride idx_testcases_status.
 */
import { sleep } from 'k6';
import { get, totalCount } from './lib/client.js';
import { config, requireConfig, banner } from './lib/config.js';
import { SEARCH_TERMS, STATUS_FILTERS, PRIORITY_FILTERS, pick } from './lib/data.js';

export const options = {
  // The scenarios pull multi-KB pages thousands of times; holding those bodies is k6-side memory
  // spent on data no assertion reads. Individual calls opt back in with { parse: true }.
  discardResponseBodies: true,

  scenarios: {
    repository: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        // Ramp rather than step to 50. An instant 50 measures connection-pool cold start as if it
        // were steady-state latency, and against production it is also simply rude.
        { duration: config.warmup, target: Math.ceil(config.vus / 5) },
        { duration: config.rampUp, target: config.vus },
        { duration: config.steady, target: config.vus },
        { duration: config.rampDown, target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },

  thresholds: {
    /*
     * abortOnFail is the production safety valve. If the error rate crosses 5% the run stops itself
     * rather than continuing to lean on an API that is already failing for real users. delayAbortEval
     * lets the first few seconds settle so one cold request cannot trip it.
     */
    tesbo_error_rate: [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '30s' }],

    // Per-operation budgets. These are starting proposals, not measured SLOs — set them from the
    // baseline run (VUS=1) and then hold the 50-VU run to them.
    'op_repo_open_page_duration': ['p(95)<1500'],
    'op_repo_page_deep_duration': ['p(95)<2500'],
    'op_repo_search_duration': ['p(95)<2000'],
    'op_repo_filter_duration': ['p(95)<1500'],
    'op_repo_summary_duration': ['p(95)<2000'],
    'op_repo_suites_duration': ['p(95)<1000'],

    // Any of these is a finding on its own, so they are thresholds rather than just counters.
    tesbo_cloudflare_524: ['count<1'],
    tesbo_db_unavailable_503: ['count<1'],
    tesbo_transport_failures: ['count<1'],
  },
};

export function setup() {
  requireConfig();
  banner('s1-repository');
  const probe = get('setup_probe', `/api/projects/${config.projectId}/testcases?limit=1&offset=0`);
  const total = totalCount(probe.res);
  if (total < config.caseCount) {
    console.warn(
      `project holds ${total} cases but CASE_COUNT is ${config.caseCount} — run load/seed.js first, ` +
        `or the deep-page and pagination numbers will not mean what they claim.`
    );
  }
  console.log(`baseline: ${total} cases in project ${config.projectId}`);
  return { total };
}

export default function (data) {
  const total = data.total || config.caseCount;
  const base = `/api/projects/${config.projectId}`;
  const seed = __VU * 1000 + __ITER;

  // --- Opening the repository screen: what the browser fires before any interaction. -----------
  get('repo_project', `${base}`);
  get('repo_suites', `${base}/suites`);
  get('repo_summary', `${base}/reports/repository-summary`);
  get('repo_open_page', `${base}/testcases?limit=${config.pageSize}&offset=0`);

  sleep(1);

  // --- Paging forward a few pages, the way someone scanning the list does. ---------------------
  for (let page = 1; page <= 3; page++) {
    get('repo_page_next', `${base}/testcases?limit=${config.pageSize}&offset=${page * config.pageSize}`);
    sleep(0.5);
  }

  // --- Jumping to the far end of a 5000-row repository. ----------------------------------------
  // Clamped so it stays a valid offset even if the project is smaller than CASE_COUNT.
  const deepOffset = Math.max(0, total - config.pageSize * 4);
  get('repo_page_deep', `${base}/testcases?limit=${config.pageSize}&offset=${deepOffset}`);

  sleep(1);

  // --- Searching and filtering, the two things a 5000-case repository forces users to do. ------
  const term = pick(SEARCH_TERMS, seed);
  get('repo_search', `${base}/testcases?limit=${config.pageSize}&offset=0&search=${encodeURIComponent(term)}`);

  get('repo_filter', `${base}/testcases?limit=${config.pageSize}&offset=0&status=${pick(STATUS_FILTERS, seed)}`);
  get('repo_filter', `${base}/testcases?limit=${config.pageSize}&offset=0&priority=${pick(PRIORITY_FILTERS, seed + 1)}`);

  sleep(1);

  // --- The largest page the server will serve. -------------------------------------------------
  // Not what the screen defaults to, but it IS what "select all" walks with and what a user who
  // sets rows-per-page to 500 gets, so its cost belongs in the picture.
  get('repo_page_max', `${base}/testcases?limit=${config.maxPageSize}&offset=0`);

  sleep(2);
}
