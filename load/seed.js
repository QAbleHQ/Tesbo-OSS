/**
 * Phase 0 — build the fixture the scenarios measure against. Run this ONCE, before them.
 *
 *   k6 run load/seed.js -e TESBO_TOKEN=tsbo_... -e PROJECT_ID=<uuid>
 *
 * This is not itself a load test: it runs at a single VU. It is the only script that creates test
 * cases, and it is separated from the scenarios on purpose — a scenario that seeded its own data
 * would measure the seeding as well as the thing under test, and re-running it would silently
 * multiply the repository it was supposed to be holding constant.
 *
 * It is, however, the first real measurement you get: bulkCreateTestCases takes a per-project
 * advisory lock and writes in one jsonb-driven statement, so the per-batch timings printed here are
 * a clean read on write throughput after the infra upgrade.
 */
import { get, post, totalCount } from './lib/client.js';
import { config, requireConfig, banner } from './lib/config.js';
import { testCaseBatch } from './lib/data.js';

export const options = {
  vus: 1,
  iterations: 1,
  // Seeding writes 500-case batches; a slow one is interesting, not a failure.
  thresholds: { tesbo_error_rate: ['rate<0.05'] },
};

export function setup() {
  requireConfig();
  banner('seed');
}

export default function () {
  // How many cases the project already holds. limit=1 because only the header matters here.
  const probe = get('seed_probe', `/api/projects/${config.projectId}/testcases?limit=1&offset=0`);
  if (!probe.ok) {
    throw new Error(
      'Could not read the target project. Check that PROJECT_ID exists and that TESBO_TOKEN belongs ' +
        'to a user with access to it.'
    );
  }
  const existing = totalCount(probe.res);
  console.log(`project currently holds ${existing} test cases`);

  if (config.reuseExisting && existing >= config.caseCount) {
    console.log(`REUSE_EXISTING=true and the project already has >= ${config.caseCount} cases — nothing to seed.`);
    return;
  }

  const toCreate = config.reuseExisting ? config.caseCount - existing : config.caseCount;
  // MAX_BULK_TESTCASES is 500 server-side; a larger batch is refused with a 400, not truncated.
  const batches = Math.ceil(toCreate / config.bulkBatchSize);
  console.log(`creating ${toCreate} cases in ${batches} batches of up to ${config.bulkBatchSize}`);

  let created = 0;
  for (let b = 0; b < batches; b++) {
    const size = Math.min(config.bulkBatchSize, toCreate - created);
    const body = testCaseBatch(existing + created + 1, size, config.tag);
    const started = Date.now();
    const r = post('seed_bulk_create', `/api/projects/${config.projectId}/testcases/bulk-create`, body, {
      parse: true,
      // Generous: this is a 500-row insert inside a transaction holding an advisory lock.
      timeout: '180s',
    });
    if (!r.ok) {
      throw new Error(`batch ${b + 1}/${batches} failed — stopping so the fixture size stays knowable.`);
    }
    created += size;
    console.log(`  batch ${b + 1}/${batches}: +${size} (${created}/${toCreate}) in ${Date.now() - started}ms`);
  }

  const after = get('seed_verify', `/api/projects/${config.projectId}/testcases?limit=1&offset=0`);
  console.log(`seed complete — project now holds ${totalCount(after.res)} test cases`);
}
