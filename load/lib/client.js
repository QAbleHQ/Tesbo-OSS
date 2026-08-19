/**
 * Authenticated HTTP helpers with per-endpoint metrics.
 *
 * k6's built-in http_req_duration is an aggregate across every request a test made, which in a mixed
 * scenario blends a 20ms suite-tree read into the same percentile as a 30s add-to-run and describes
 * neither. Every call here therefore records its own Trend, keyed by a short operation name, so the
 * summary reports each endpoint separately.
 *
 * Requests are also tagged `op:<name>`, which is what lets `--out` backends (Prometheus, InfluxDB,
 * k6 Cloud) slice the same data without re-running anything.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import { config, headers } from './config.js';

/*
 * Every operation name the suite can emit, declared up front.
 *
 * This list exists because k6 requires custom metrics to be constructed in the INIT context — a
 * `new Trend()` reached for the first time inside a VU throws "metrics must be declared in the init
 * context" mid-run. Registering them lazily on first use therefore cannot work, and a threshold
 * naming a metric that was never registered is rejected at startup rather than ignored.
 *
 * So: add the op here first, then use it. An unknown name passed to get/post/patch/del fails loudly
 * (see metricsFor) rather than silently recording nothing.
 */
const OPS = [
  // setup / seeding
  'setup_probe', 'setup_cycles', 'setup_executions', 'seed_probe', 'seed_bulk_create', 'seed_verify',
  // repository reads
  'repo_project', 'repo_suites', 'repo_summary', 'repo_open_page', 'repo_page_next',
  'repo_page_deep', 'repo_search', 'repo_filter', 'repo_page_max', 'repo_case_detail',
  // run building and reading
  'run_create', 'run_collect_ids', 'run_add_cases', 'run_open_cycle', 'run_open_executions',
  'run_open_summary', 'run_read_executions',
  // execution work
  'exec_update_status', 'exec_bulk_status',
  // concurrent writes
  'write_bulk_create', 'write_create_case', 'write_read_executions',
  // teardown
  'teardown_list_cycles', 'teardown_delete_cycle', 'teardown_list_cases', 'teardown_bulk_delete',
];

const trends = {};
const sizes = {};
for (const op of OPS) {
  trends[op] = new Trend(`op_${op}_duration`, true);
  sizes[op] = new Trend(`op_${op}_bytes`);
}

const errors = new Counter('tesbo_errors');
const errorRate = new Rate('tesbo_error_rate');

/*
 * Failures worth counting apart, because each points at a different layer and a different fix. All
 * three arrive as "not a 200":
 *
 *  - status 0   — no HTTP response at all: connection reset, DNS, or k6's own timeout. This is the
 *                 shape the keep-alive bug produced (the server FINs a pooled socket and the next
 *                 request written into it dies as ECONNRESET rather than as any status).
 *  - status 524 — Cloudflare gave up waiting for the origin at its 100s proxy limit. The origin may
 *                 well still be running the statement. addCycleTestCases' own source comment records
 *                 this happening in production on "select all".
 *  - status 503 — DatabaseService.rethrow(): the pool could not hand out a connection inside
 *                 DB_CONNECTION_TIMEOUT_MS. With DB_POOL_MAX at 20 and 50 VUs offered, this says the
 *                 pool — not the query — is the ceiling.
 */
const timeouts524 = new Counter('tesbo_cloudflare_524');
const unavailable503 = new Counter('tesbo_db_unavailable_503');
const transportFailures = new Counter('tesbo_transport_failures');

function metricsFor(op) {
  if (!trends[op]) {
    throw new Error(`unknown op "${op}" — add it to the OPS list in load/lib/client.js first.`);
  }
  return { trend: trends[op], size: sizes[op] };
}

function url(path) {
  return `${config.baseUrl}${path}`;
}

/*
 * Success is any 2xx unless a caller pins an exact code.
 *
 * A load test measures latency and real failures; it is not the place to re-assert which 2xx Nest
 * chose for a given verb. The e2e suite itself asserts `res.ok()` rather than exact codes on these
 * endpoints, so pinning 201-vs-200 here would invent failures that no test in the repo considers
 * failures — and with abortOnFail armed, one of those would halt a production run for nothing.
 */
function statusOk(status, expected) {
  return expected ? status === expected : status >= 200 && status < 300;
}

function record(op, res, expectedStatus) {
  const m = metricsFor(op);
  m.trend.add(res.timings.duration, { op });

  /*
   * Body length first, Content-Length only as the fallback.
   *
   * They are different numbers and the difference matters here: behind Cloudflare the header
   * reports COMPRESSED wire bytes (when it is present at all — a chunked response omits it), while
   * the decoded body is what the browser actually has to parse and hold in memory. For the
   * unbounded executions endpoint the second number is the one that describes the problem, so
   * prefer it whenever the call opted into reading the body.
   */
  const bytes = res.body ? res.body.length : Number(res.headers['Content-Length'] || 0);
  if (bytes) m.size.add(bytes, { op });

  const label = expectedStatus ? `${op} -> ${expectedStatus}` : `${op} -> 2xx`;
  const ok = check(res, { [label]: (r) => statusOk(r.status, expectedStatus) }, { op });

  if (!ok) {
    errors.add(1, { op, status: String(res.status) });
    if (res.status === 0) transportFailures.add(1, { op });
    if (res.status === 524) timeouts524.add(1, { op });
    if (res.status === 503) unavailable503.add(1, { op });
    // Truncated: an error body from a 5000-row endpoint is not something to put in a log.
    const detail = res.body ? String(res.body).slice(0, 300) : res.error || 'no body';
    console.error(
      `[${op}] expected ${expectedStatus || '2xx'}, got ${res.status} ` +
        `(${Math.round(res.timings.duration)}ms): ${detail}`
    );
  }
  errorRate.add(!ok, { op });
  return ok;
}

/*
 * Shared request options.
 *
 * The 120s default timeout is chosen to sit just ABOVE Cloudflare's 100s proxy limit, so a 524 is
 * observed as a 524 instead of being pre-empted by k6 and miscounted as a status-0 transport
 * failure — the very distinction the counters above exist to draw.
 *
 * responseType 'none' unless a caller asks to parse: the scenarios run with discardResponseBodies,
 * and a 5000-row executions payload held by 50 VUs at once is hundreds of MB of k6-side memory for
 * data most iterations never read.
 */
function reqOpts(op, opts) {
  return {
    headers,
    tags: { op },
    timeout: opts.timeout || '120s',
    responseType: opts.parse ? 'text' : 'none',
  };
}

function safeJson(res) {
  try {
    return res.json();
  } catch (e) {
    console.error(`[decode] could not parse JSON: ${String(e).slice(0, 200)}`);
    return null;
  }
}

function finish(op, res, opts) {
  const ok = record(op, res, opts.expect);
  return { res, ok, json: opts.parse && ok ? safeJson(res) : null };
}

export function get(op, path, opts = {}) {
  return finish(op, http.get(url(path), reqOpts(op, opts)), opts);
}

export function post(op, path, body, opts = {}) {
  return finish(op, http.post(url(path), JSON.stringify(body), reqOpts(op, opts)), opts);
}

export function patch(op, path, body, opts = {}) {
  return finish(op, http.patch(url(path), JSON.stringify(body), reqOpts(op, opts)), opts);
}

export function del(op, path, opts = {}) {
  return finish(op, http.del(url(path), null, reqOpts(op, opts)), opts).ok;
}

/**
 * Total row count for a list endpoint.
 *
 * listTestCases folds the count into the same statement as the rows (COUNT(*) OVER ()) and returns
 * it in X-Total-Count rather than in the body, so paging logic reads the header — asking for the
 * body just to count it would double the payload for nothing.
 */
export function totalCount(res) {
  const raw = res.headers['X-Total-Count'] || res.headers['x-total-count'];
  return raw ? Number(raw) : 0;
}
