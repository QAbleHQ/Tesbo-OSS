/**
 * Scenario 3 — 50 concurrent users doing all of the above at once.
 *
 *   k6 run load/s3-mixed-50vu.js -e TESBO_TOKEN=... -e PROJECT_ID=... -e VUS=50
 *
 * Scenarios 1 and 2 measure endpoints in isolation, which is how you find a slow query. This one
 * measures the system, which is how you find a slow *system* — and the two failure modes it exists
 * to provoke do not appear in an isolated test at all:
 *
 *  - Connection pool exhaustion. DB_POOL_MAX defaults to 20. Offer 50 concurrent users and the
 *    21st in-flight statement waits, then fails at DB_CONNECTION_TIMEOUT_MS (10s) — which
 *    DatabaseService now turns into a 503 and logs with a pool census. tesbo_db_unavailable_503 in
 *    the summary is the direct read on whether 20 is the right number for the upgraded box, and the
 *    backend log line that accompanies it (`waiting > 0, idle = 0` vs `waiting = 0`) says whether
 *    to raise `max` or look upstream at the pooler.
 *
 *  - One heavy request starving many light ones. A single unbounded executions read holds a pool
 *    connection for its whole duration. Watching op_repo_open_page_duration degrade while the run
 *    openers are active is that interference made visible — and it is the reason the read mix here
 *    is weighted rather than uniform.
 *
 * The weighting is roughly what the product's own traffic looks like: most people are browsing the
 * repository, some are working inside a run, a few are writing.
 */
import { sleep } from 'k6';
import { get, post, patch, totalCount } from './lib/client.js';
import { config, requireConfig, banner } from './lib/config.js';
import { SEARCH_TERMS, STATUS_FILTERS, EXECUTION_STATUSES, testCaseBatch, pick } from './lib/data.js';

const total = config.vus;
const browsers = Math.max(1, Math.round(total * 0.7)); // 70% — reading the repository
const runners = Math.max(1, Math.round(total * 0.2));  // 20% — working inside a run
const writers = Math.max(1, total - browsers - runners); // 10% — creating and updating

const RAMP = [
  { duration: config.warmup, target: 0.2 },
  { duration: config.rampUp, target: 1 },
  { duration: config.steady, target: 1 },
  { duration: config.rampDown, target: 0 },
];

/** Builds a ramping-vus stage list scaled to this role's share of the VU budget. */
function stagesFor(share) {
  return RAMP.map((s) => ({ duration: s.duration, target: Math.max(0, Math.round(share * s.target)) }));
}

export const options = {
  discardResponseBodies: true,

  scenarios: {
    browse: { executor: 'ramping-vus', exec: 'browse', startVUs: 0, stages: stagesFor(browsers), gracefulRampDown: '30s' },
    workRun: { executor: 'ramping-vus', exec: 'workRun', startVUs: 0, stages: stagesFor(runners), gracefulRampDown: '30s' },
    write: { executor: 'ramping-vus', exec: 'write', startVUs: 0, stages: stagesFor(writers), gracefulRampDown: '30s' },
  },

  thresholds: {
    tesbo_error_rate: [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '60s' }],
    tesbo_cloudflare_524: ['count<1'],
    tesbo_transport_failures: ['count<1'],
    /*
     * Not a hard zero, unlike scenarios 1 and 2.
     *
     * A 503 here is the finding rather than a malfunction — it is what pool saturation is SUPPOSED
     * to look like now that DatabaseService classifies it, and aborting the run on the first one
     * would destroy the evidence of how bad it gets. It still fails the run, so it cannot pass
     * unnoticed.
     */
    tesbo_db_unavailable_503: ['count<10'],

    // Latency under concurrency is the whole question, so these carry the interesting budgets.
    'op_repo_open_page_duration': ['p(95)<2000'],
    'op_repo_search_duration': ['p(95)<3000'],
    'op_run_open_executions_duration': ['p(95)<30000'],
    'http_req_failed': ['rate<0.05'],
  },
};

export function setup() {
  requireConfig();
  banner('s3-mixed-50vu');
  console.log(`VU split: ${browsers} browsing / ${runners} in-run / ${writers} writing`);

  const probe = get('setup_probe', `/api/projects/${config.projectId}/testcases?limit=1&offset=0`);
  const caseTotal = totalCount(probe.res);

  // The run openers need runs that actually hold cases. Prefer this campaign's own fixtures so a
  // mixed run never leans on a customer's data to generate its load.
  const cycles = get('setup_cycles', `/api/projects/${config.projectId}/cycles`, { parse: true });
  const all = (cycles.ok && cycles.json) || [];
  const mine = all.filter((c) => c.name && c.name.indexOf(config.tag) !== -1);
  const usable = (mine.length ? mine : all).map((c) => c.id);

  if (!usable.length) {
    throw new Error(
      'no runs found in the target project — run load/s2-run-build.js first so there is something ' +
        'for the in-run VUs to open.'
    );
  }

  /*
   * A pool of execution ids for the writer VUs to update, read ONCE here rather than per iteration.
   *
   * The alternative — each writer re-reading all 5000 executions just to pick one row to PATCH —
   * was wrong twice over. It is not what the product does (the run screen already holds the list
   * from the single read it did on open, so a tester patching 40 rows performs one read and forty
   * updates, not forty reads), and it made the writers generate more heavy-read load than the
   * in-run VUs whose actual job that is. Sampling here keeps the write mix a write mix.
   */
  const execPool = [];
  for (const cycleId of usable.slice(0, 2)) {
    const execs = get('setup_executions', `/api/cycles/${cycleId}/executions`, {
      parse: true,
      timeout: '180s',
    });
    if (execs.ok && execs.json) {
      // Capped: setup data is serialised to every VU, so this is kept to a working sample.
      for (const e of execs.json.slice(0, 250)) execPool.push({ cycleId, id: e.id });
    }
  }

  console.log(
    `${caseTotal} cases, ${usable.length} runs available (${mine.length} tagged ${config.tag}), ` +
      `${execPool.length} executions sampled for writers`
  );
  return { caseTotal, cycleIds: usable, execPool };
}

/** 70% — the repository screen, paging, searching, filtering. */
export function browse(data) {
  const base = `/api/projects/${config.projectId}`;
  const seed = __VU * 1000 + __ITER;

  get('repo_suites', `${base}/suites`);
  get('repo_summary', `${base}/reports/repository-summary`);
  get('repo_open_page', `${base}/testcases?limit=${config.pageSize}&offset=0`);
  sleep(1);

  const page = 1 + (seed % 20);
  get('repo_page_next', `${base}/testcases?limit=${config.pageSize}&offset=${page * config.pageSize}`);
  sleep(0.5);

  const deepOffset = Math.max(0, (data.caseTotal || config.caseCount) - config.pageSize * 4);
  get('repo_page_deep', `${base}/testcases?limit=${config.pageSize}&offset=${deepOffset}`);
  sleep(0.5);

  get('repo_search', `${base}/testcases?limit=${config.pageSize}&offset=0&search=${encodeURIComponent(pick(SEARCH_TERMS, seed))}`);
  get('repo_filter', `${base}/testcases?limit=${config.pageSize}&offset=0&status=${pick(STATUS_FILTERS, seed)}`);

  sleep(2);
}

/** 20% — inside a run: the unbounded executions read, plus the reports around it. */
export function workRun(data) {
  const cycleId = pick(data.cycleIds, __VU * 31 + __ITER);
  get('run_open_cycle', `/api/cycles/${cycleId}`);
  // The heavy one. This is the request that holds a pool connection long enough to be felt by the
  // browsing VUs above.
  get('run_open_executions', `/api/cycles/${cycleId}/executions`, { timeout: '120s' });
  get('run_open_summary', `/api/cycles/${cycleId}/report/summary`);
  sleep(3);
}

/** 10% — concurrent writes: execution status updates, with occasional case creation. */
export function write(data) {
  const base = `/api/projects/${config.projectId}`;
  const seed = __VU * 1000 + __ITER;

  /*
   * Status updates dominate, because in a test management tool they genuinely do: a tester works
   * through a run marking rows, and that is the write the system actually serves all day. Three per
   * iteration against the pool sampled in setup().
   */
  if (data.execPool && data.execPool.length) {
    for (let i = 0; i < 3; i++) {
      const target = data.execPool[(seed * 3 + i) % data.execPool.length];
      patch('exec_update_status', `/api/cycles/${target.cycleId}/executions/${target.id}`, {
        status: pick(EXECUTION_STATUSES, seed + i),
        actualResult: 'k6 load fixture result',
      });
      sleep(0.3);
    }
  }

  // A single-case create, the ordinary path from the "New test case" form.
  post('write_create_case', `${base}/testcases`, {
    title: `[${config.tag}] single ${seed}`,
    description: 'k6 load fixture — safe to delete',
    priority: 'P2',
    type: 'Functional',
    steps: [{ step: 'do the thing', expected: 'the thing is done' }],
  });

  /*
   * A bulk import every 10th iteration only.
   *
   * It is here to exercise the per-project advisory lock bulkCreateTestCases takes to allocate
   * external ids — every concurrent writer serialises on that same lock, which is the contention
   * worth measuring. It is throttled because it is also the one write that CHANGES THE FIXTURE: at
   * 25 rows every iteration the repository grew by roughly 8,000 cases over a ten-minute run, so
   * the browsing VUs spent the second half measuring a 13,000-case project while reporting it as a
   * 5,000-case result. Rare enough to keep the lock contested, rare enough to leave the premise
   * intact.
   */
  if (__ITER % 10 === 0) {
    post('write_bulk_create', `${base}/testcases/bulk-create`, testCaseBatch(900000 + seed * 100, 25, config.tag), {
      timeout: '120s',
    });
  }

  sleep(3);
}
