/**
 * Scenario 2 — "build a regression run holding all 5000 cases, 5-10 times over."
 *
 *   k6 run load/s2-run-build.js -e TESBO_TOKEN=... -e PROJECT_ID=... -e RUN_COUNT=10
 *
 * WRITES. Each iteration creates one run and fills it with the whole repository, so RUN_COUNT=10
 * against a 5000-case project materialises 50,000 cycle_items and 50,000 executions. Run
 * load/teardown.js afterwards.
 *
 * This models the real "select all → add to run" journey exactly, and the shape matters:
 *
 *   1. POST /api/projects/:id/cycles                 — create the run. from-cases and from-plan are
 *                                                      aliases for this and seed no items (pinned by
 *                                                      e2e/api/cycles.spec.ts), so the UI always
 *                                                      does create-then-add and so does this.
 *   2. GET  .../testcases?limit=500&offset=N  × 10   — "select all" does NOT send a flag; the client
 *                                                      walks the entire repository at the 500 ceiling
 *                                                      to collect ids first (testcases/page.tsx:617).
 *                                                      Ten sequential round trips before the write
 *                                                      even starts, and they are on the user's clock.
 *   3. POST /api/cycles/:id/testcases                — 5000 ids in one body.
 *   4. GET  /api/cycles/:id/executions               — opening the run you just built.
 *
 * Step 3 is the one with production history: its own source comment records this call timing out at
 * Cloudflare's 100s proxy limit and surfacing as a 524. It is now a single statement, but that
 * statement runs under a 30s statement_timeout, so there are two distinct cliffs to watch for and
 * the client classifies them apart (524 vs 503 vs transport).
 *
 * Step 4 is the one with no ceiling at all: that endpoint takes no limit/offset and returns every
 * execution with the full case body inlined — description, preconditions, postconditions, steps,
 * test_data. At 5000 rows this is the largest single response the product can be asked to produce,
 * and op_run_open_executions_bytes in the summary is the number to look at.
 */
import { sleep } from 'k6';
import { get, post, patch, totalCount } from './lib/client.js';
import { config, requireConfig, banner } from './lib/config.js';
import { EXECUTION_STATUSES, pick } from './lib/data.js';

// A few builders at once, not fifty: building a regression run is something a handful of leads do,
// and RUN_COUNT runs is the point of the scenario. Raise with -e BUILD_VUS to force contention.
const buildVus = Number(__ENV.BUILD_VUS || 2);

export const options = {
  discardResponseBodies: true,

  scenarios: {
    runBuild: {
      // shared-iterations, so exactly RUN_COUNT runs get built no matter how many VUs share the work.
      executor: 'shared-iterations',
      vus: Math.min(buildVus, config.runCount),
      iterations: config.runCount,
      // 5000-case adds plus a 10-page id walk each; give the whole thing room rather than have k6
      // cut an iteration off mid-write and leave a half-built run behind.
      maxDuration: '60m',
    },
  },

  thresholds: {
    tesbo_error_rate: [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '60s' }],

    // The two cliffs. Any occurrence is a finding, so both are hard zeros.
    tesbo_cloudflare_524: ['count<1'],
    tesbo_db_unavailable_503: ['count<1'],
    tesbo_transport_failures: ['count<1'],

    // Budgets: proposals to replace with measured baselines.
    'op_run_create_duration': ['p(95)<1000'],
    'op_run_collect_ids_duration': ['p(95)<3000'],
    // Deliberately generous and still well under Cloudflare's 100s: the point is to catch the cliff,
    // not to fail the run for being slower than a guess.
    'op_run_add_cases_duration': ['p(95)<60000'],
    'op_run_open_executions_duration': ['p(95)<30000'],
  },
};

export function setup() {
  requireConfig();
  banner('s2-run-build');
  const probe = get('setup_probe', `/api/projects/${config.projectId}/testcases?limit=1&offset=0`);
  const total = totalCount(probe.res);
  if (!total) throw new Error('the target project has no test cases — run load/seed.js first.');
  console.log(
    `building ${config.runCount} runs from ${total} cases (addMode=${config.addMode}` +
      `${config.addMode === 'chunked' ? `, chunk=${config.addChunkSize}` : ''})`
  );
  return { total };
}

export default function (data) {
  const total = data.total;
  const base = `/api/projects/${config.projectId}`;
  const label = `[${config.tag}] Regression ${Date.now()}-${__VU}-${__ITER}`;

  // --- 1. Create the run. ----------------------------------------------------------------------
  const created = post('run_create', `${base}/cycles`, {
    name: label,
    description: 'k6 load fixture — safe to delete',
    environment: 'load-test',
    buildVersion: `k6-${__VU}.${__ITER}`,
  }, { parse: true });

  if (!created.ok || !created.json || !created.json.id) {
    console.error('run creation failed — skipping the rest of this iteration');
    return;
  }
  const cycleId = created.json.id;

  // --- 2. "Select all": walk the repository at the 500 ceiling to collect every id. -------------
  const ids = [];
  const pages = Math.ceil(total / config.maxPageSize);
  for (let p = 0; p < pages; p++) {
    const r = get(
      'run_collect_ids',
      `${base}/testcases?limit=${config.maxPageSize}&offset=${p * config.maxPageSize}`,
      { parse: true }
    );
    if (!r.ok || !r.json) break;
    for (const row of r.json) ids.push(row.id);
  }
  console.log(`[${label}] collected ${ids.length} ids in ${pages} pages`);
  if (!ids.length) return;

  // --- 3. Add them to the run. -----------------------------------------------------------------
  if (config.addMode === 'chunked') {
    // The comparison arm: does splitting the write keep every request comfortably inside the
    // statement timeout and the proxy limit, at the cost of more round trips?
    for (let i = 0; i < ids.length; i += config.addChunkSize) {
      const chunk = ids.slice(i, i + config.addChunkSize);
      post('run_add_cases', `/api/cycles/${cycleId}/testcases`, { testcaseIds: chunk }, {
        timeout: '120s',
      });
    }
  } else {
    // The arm that matches today's UI: the entire selection in one request.
    const added = post('run_add_cases', `/api/cycles/${cycleId}/testcases`, { testcaseIds: ids }, {
      parse: true,
      timeout: '120s',
    });
    if (added.ok && added.json) {
      // added + skipped must account for every id sent; a shortfall means rows silently did not land.
      console.log(`[${label}] requested=${added.json.requested} added=${added.json.added} skipped=${added.json.skipped}`);
    }
  }

  sleep(1);

  // --- 4. Open the run you just built: the unbounded executions read. ---------------------------
  get('run_open_executions', `/api/cycles/${cycleId}/executions`, { timeout: '120s' });
  get('run_open_summary', `/api/cycles/${cycleId}/report/summary`);

  sleep(1);

  // --- 5. Work the run a little, the way a tester would. ----------------------------------------
  // Needs real execution ids, so this is the one place the big body is parsed. Kept to the first
  // iteration of each VU: holding a 5000-row payload on every iteration is k6-side memory spent to
  // re-learn something already measured.
  if (__ITER === 0) {
    const execs = get('run_read_executions', `/api/cycles/${cycleId}/executions`, {
      parse: true,
      timeout: '120s',
    });
    if (execs.ok && execs.json && execs.json.length) {
      const sample = execs.json.slice(0, 5);
      for (const e of sample) {
        patch('exec_update_status', `/api/cycles/${cycleId}/executions/${e.id}`, {
          status: pick(EXECUTION_STATUSES, __VU + e.id.charCodeAt(0)),
          actualResult: 'k6 load fixture result',
        });
      }
      // The bulk path the UI's multi-select uses — one statement across a large selection.
      const bulkIds = execs.json.slice(0, 250).map((e) => e.id);
      post('exec_bulk_status', `/api/cycles/${cycleId}/executions/bulk-status`, {
        executionIds: bulkIds,
        status: 'Passed',
      }, { timeout: '120s' });
    }
  }

  sleep(2);
}
