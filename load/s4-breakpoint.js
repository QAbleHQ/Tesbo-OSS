/**
 * Scenario 4 — where does it break? (optional, run last)
 *
 *   k6 run load/s4-breakpoint.js -e TESBO_TOKEN=... -e PROJECT_ID=... -e PEAK_RPS=200
 *
 * Scenarios 1-3 answer "does 50 users work". This one answers "what is the headroom", which is the
 * question an infra upgrade is actually asking.
 *
 * It uses an OPEN model (ramping-arrival-rate) and that choice is the entire point. A closed model
 * — fixed VUs, each waiting for its response before sending the next — silently reduces the offered
 * load as the server slows, so a saturated system reports the same request rate as a healthy one
 * with worse latency, and never shows a breaking point. An arrival-rate executor keeps sending at
 * the target rate regardless, which is what real users do, so saturation shows up as growing latency
 * and then errors instead of hiding as reduced throughput.
 *
 * Read-only, so it is the safest of the four to push hard. Watch for the knee: the RPS at which
 * op_repo_open_page_duration starts climbing superlinearly, and the RPS at which
 * tesbo_db_unavailable_503 first appears.
 */
import { get } from './lib/client.js';
import { config, requireConfig, banner } from './lib/config.js';
import { SEARCH_TERMS, pick } from './lib/data.js';

const peakRps = Number(__ENV.PEAK_RPS || 200);

export const options = {
  discardResponseBodies: true,

  scenarios: {
    breakpoint: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      // preAllocatedVUs must be generous: k6 needs a free VU to start each arriving iteration, and
      // if it runs out it reports "dropped_iterations" — which looks like a client-side shortfall
      // but is really the harness failing to offer the load it claimed to.
      preAllocatedVUs: Math.max(50, peakRps),
      maxVUs: Math.max(200, peakRps * 4),
      // Four equal steps to the peak, so the knee can be read off the step it appears on.
      stages: [
        { duration: config.rampUp, target: Math.round(peakRps * 0.25) },
        { duration: config.rampUp, target: Math.round(peakRps * 0.5) },
        { duration: config.rampUp, target: Math.round(peakRps * 0.75) },
        { duration: config.steady, target: peakRps },
        { duration: config.rampDown, target: 0 },
      ],
    },
  },

  thresholds: {
    /*
     * Deliberately loose and abortOnFail'd at a level that means "production is genuinely hurting",
     * not "we found the knee". Finding the knee IS the goal here, so a rising error rate is a
     * result; a 25% error rate is a reason to stop leaning on a live system.
     */
    tesbo_error_rate: [{ threshold: 'rate<0.25', abortOnFail: true, delayAbortEval: '30s' }],
    // Surfaced in the summary as the headline capacity numbers rather than as pass/fail gates.
    'op_repo_open_page_duration': ['p(95)<5000'],
    'dropped_iterations': ['count<100'],
  },
};

export function setup() {
  requireConfig();
  banner('s4-breakpoint');
  console.log(`ramping to ${peakRps} req/s — read-only`);
}

export default function () {
  const base = `/api/projects/${config.projectId}`;
  const seed = __VU * 1000 + __ITER;

  // One light request per iteration, so the arrival rate IS the request rate and the resulting
  // number is directly quotable as "the API served N req/s at p95 = X".
  if (seed % 5 === 0) {
    get('repo_search', `${base}/testcases?limit=${config.pageSize}&offset=0&search=${encodeURIComponent(pick(SEARCH_TERMS, seed))}`);
  } else {
    get('repo_open_page', `${base}/testcases?limit=${config.pageSize}&offset=${(seed % 20) * config.pageSize}`);
  }
}
