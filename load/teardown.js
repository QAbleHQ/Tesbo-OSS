/**
 * Cleanup — removes everything the load campaign created, and nothing else.
 *
 *   k6 run load/teardown.js -e TESBO_TOKEN=... -e PROJECT_ID=... -e CONFIRM_DELETE=true
 *
 * Deletes are matched strictly on the RUN_TAG stamped into every fixture name by data.js and
 * s2-run-build.js. Anything not carrying that tag is left alone, and without CONFIRM_DELETE=true
 * this script only reports what it WOULD delete — a dry run is the default because this is pointed
 * at production and "I'll just clean up quickly" is how real data goes missing.
 *
 * Deleting a cycle cascades to its cycle_items and their executions, so runs need no separate
 * item-level cleanup.
 */
import { get, post, del } from './lib/client.js';
import { config, requireConfig, banner } from './lib/config.js';

export const options = { vus: 1, iterations: 1 };

export function setup() {
  requireConfig();
  banner('teardown');
  if (!config.confirmDelete) {
    console.log('DRY RUN — nothing will be deleted. Re-run with -e CONFIRM_DELETE=true to apply.');
  }
}

export default function () {
  const base = `/api/projects/${config.projectId}`;

  // --- Runs -------------------------------------------------------------------------------------
  const cycles = get('teardown_list_cycles', `${base}/cycles`, { parse: true });
  const tagged = ((cycles.ok && cycles.json) || []).filter((c) => c.name && c.name.indexOf(config.tag) !== -1);
  console.log(`runs matching tag "${config.tag}": ${tagged.length}`);
  for (const c of tagged) {
    if (!config.confirmDelete) {
      console.log(`  would delete run ${c.id} — ${c.name}`);
      continue;
    }
    // Any 2xx counts: a row a previous teardown already removed is not a failure worth stopping on.
    del('teardown_delete_cycle', `/api/cycles/${c.id}`, { timeout: '120s' });
    console.log(`  deleted run ${c.id}`);
  }

  // --- Test cases -------------------------------------------------------------------------------
  /*
   * Paged by repeatedly reading the FIRST page rather than walking offsets.
   *
   * Deleting from a list you are simultaneously offsetting through skips rows: every delete shifts
   * the remainder left, so offset=500 after a 500-row delete lands past the rows that moved down
   * into the range already read. Re-reading page one each time is the only stable way to drain it.
   */
  let removed = 0;
  for (let guard = 0; guard < 200; guard++) {
    const page = get(
      'teardown_list_cases',
      `${base}/testcases?limit=${config.maxPageSize}&offset=0&search=${encodeURIComponent(config.tag)}&includeArchived=true`,
      { parse: true }
    );
    if (!page.ok || !page.json || !page.json.length) break;

    // search matches description and type as well as title, so re-check the title before deleting.
    const ids = page.json.filter((t) => t.title && t.title.indexOf(config.tag) !== -1).map((t) => t.id);
    if (!ids.length) break;

    if (!config.confirmDelete) {
      console.log(`  would delete ${ids.length} test cases (first page of matches; re-run to see the rest)`);
      break;
    }
    const r = post('teardown_bulk_delete', `${base}/testcases/bulk-delete`, { testcaseIds: ids }, {
      timeout: '120s',
    });
    if (!r.ok) break;
    removed += ids.length;
    console.log(`  deleted ${removed} test cases so far`);
  }

  console.log(config.confirmDelete ? `teardown complete — ${tagged.length} runs, ${removed} cases removed` : 'dry run complete');
}
