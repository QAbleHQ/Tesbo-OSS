/**
 * Fixture generators.
 *
 * Payload weight is part of what these scenarios measure, so the generated cases are deliberately
 * realistic rather than minimal. GET /api/cycles/:id/executions returns the FULL case body per row —
 * description, preconditions, postconditions, steps, test_data — so a run of 5000 stub cases
 * ("title only") would produce a response an order of magnitude smaller than a real customer's and
 * would quietly prove nothing about the endpoint most at risk.
 *
 * Eight steps and a paragraph of description is a middling real test case, not a worst case.
 */

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const TYPES = ['Functional', 'Regression', 'Smoke', 'Integration'];
const STATUSES = ['Draft', 'Active', 'Ready'];

const LOREM =
  'Verifies the behaviour end to end against the configured environment, covering the happy path ' +
  'and the documented error responses. Preconditions are established by the fixture layer and the ' +
  'assertions read persisted state rather than transient UI affordances.';

function steps(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      step: `Step ${i}: navigate to the module under test and apply the ${i} configuration.`,
      expected: `Step ${i} completes and the resulting state is persisted and visible on reload.`,
    });
  }
  return out;
}

/**
 * One test case payload.
 *
 * `externalId` is deliberately NOT set: bulkCreateTestCases allocates external ids under a
 * per-project advisory lock and derives them from the batch index. Supplying our own would sidestep
 * that allocation — and the lock contention it creates between concurrent imports is precisely one
 * of the things a load test on this endpoint should be feeling.
 */
export function testCase(index, tag) {
  return {
    title: `[${tag}] Load fixture case ${index}`,
    description: `${LOREM} (fixture ${index})`,
    preconditions: 'A provisioned workspace, an authenticated user, and a seeded project.',
    postconditions: 'State is restored and no fixture data is left behind.',
    steps: steps(8),
    testData: `{"fixture": ${index}, "tag": "${tag}"}`,
    priority: PRIORITIES[index % PRIORITIES.length],
    type: TYPES[index % TYPES.length],
    status: STATUSES[index % STATUSES.length],
    automationStatus: index % 3 === 0 ? 'Automated' : 'Not Automated',
  };
}

/** A batch of `size` cases starting at `start`, shaped for POST .../testcases/bulk-create. */
export function testCaseBatch(start, size, tag) {
  const testcases = [];
  for (let i = 0; i < size; i++) testcases.push(testCase(start + i, tag));
  return { testcases };
}

/** Deterministic-ish pseudo random, so a VU's choices vary without importing a PRNG. */
export function pick(list, seed) {
  return list[Math.abs(Math.floor(seed)) % list.length];
}

/** Search terms that exercise the trigram indexes added in V82 with varying selectivity. */
export const SEARCH_TERMS = ['load', 'fixture', 'case 1', 'navigate', 'persisted', 'zzz-no-match'];

export const STATUS_FILTERS = ['Draft', 'Active', 'Ready'];
export const PRIORITY_FILTERS = PRIORITIES;
export const EXECUTION_STATUSES = ['Passed', 'Failed', 'Blocked', 'Skipped', 'Retest'];
