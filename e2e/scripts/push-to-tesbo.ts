/*
 * Pushes this Playwright suite into a Tesbo project as automated test cases.
 *
 * Tesbo manages its own regression suite: every `test()` in e2e/ becomes a test case, linked back to
 * the spec that implements it through the automation_* columns createTestCase already carries. The
 * suite tree mirrors the folder layout — one parent suite per Playwright project (API / UI), one
 * child suite per spec file.
 *
 * The source of truth stays in e2e/. This script only reflects it, so it is safe to re-run: a spec is
 * matched against what the project already holds — first on the `[ID]` its title carries, then on its
 * normalized prose — and left alone if it is already there. Nothing is ever deleted; a spec removed
 * from the repo leaves its case behind for a human to retire, because deleting test cases would take
 * their execution history with them.
 *
 * Verified idempotent against the stage project on 2026-08-18: 221 created on the first pass, 0 on
 * the second. If a re-run ever proposes creating anything that has not just been added to e2e/, the
 * matching below is wrong — do not "fix" it by pushing anyway.
 *
 *   TESBO_BASE_URL=https://api-app-stage.tesbo.io \
 *   TESBO_TOKEN=tsbo_xxx \
 *   TESBO_PROJECT_ID=<uuid> \
 *   node --experimental-strip-types scripts/push-to-tesbo.ts --dry-run
 *
 * The token is a project-scoped API key (Settings → API tokens, or POST /api/projects/:id/apikeys)
 * and travels as `Authorization: Bearer`. It is read from the environment and never logged.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";

interface PlaywrightSpec {
  file: string;
  line: number;
  title: string;
  suitePath: string[];
}

interface TesboCase {
  id: string;
  title: string;
  suiteId?: string | null;
}

const DRY_RUN = process.argv.includes("--dry-run");
/*
 * Resolved from argv[1] rather than __dirname so the script runs under both `tsx` (CommonJS, where
 * __dirname exists) and `node --experimental-strip-types` (ES module, where it does not). Node 22+
 * can run this file directly, which is one less dependency than tsx.
 */
const SCRIPT_DIR = path.dirname(path.resolve(process.argv[1] ?? "e2e/scripts/push-to-tesbo.ts"));
const E2E_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. See the header of this file for the three it needs.`);
    process.exit(2);
  }
  return value;
}

const BASE_URL = required("TESBO_BASE_URL").replace(/\/$/, "");
const TOKEN = required("TESBO_TOKEN");
const PROJECT_ID = required("TESBO_PROJECT_ID");

/** The repo the specs live in, so a case in Tesbo points back at real source. */
function repoUrl(): string {
  if (process.env.TESBO_REPO) return process.env.TESBO_REPO;
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}

/* ─────────────────────────────── reading the suite ─────────────────────────────── */

/**
 * `playwright test --list --reporter=json` rather than parsing the spec files: parametrised tests
 * (ui/theme.spec.ts generates 49 from 18 `test(` calls) only exist after the files are evaluated, so
 * grepping the source undercounts every file that builds its cases in a loop.
 */
function readSuite(): PlaywrightSpec[] {
  const raw = execFileSync("npx", ["playwright", "test", "--list", "--reporter=json"], {
    cwd: E2E_ROOT,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      // --list still resolves the config, which reads these; they need to be set but are never called.
      API_BASE_URL: process.env.API_BASE_URL ?? "http://localhost:1021",
      WEB_BASE_URL: process.env.WEB_BASE_URL ?? "http://localhost:1020",
    },
  });

  const report = JSON.parse(raw);
  const out: PlaywrightSpec[] = [];

  const walk = (node: any, trail: string[]): void => {
    for (const spec of node.specs ?? []) {
      out.push({
        file: spec.file,
        line: spec.line,
        title: spec.title,
        // The first trail entry is the file name Playwright uses as the root suite; drop it, the
        // file is already carried on its own.
        suitePath: trail.slice(1),
      });
    }
    for (const child of node.suites ?? []) walk(child, [...trail, child.title]);
  };

  for (const file of report.suites ?? []) walk(file, [file.title]);
  return out;
}

/* ─────────────────────────────── the Tesbo side ─────────────────────────────── */

async function api(method: string, urlPath: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${urlPath} → ${res.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * The leading identifier a spec title carries, e.g. "THM-04", "PRJ-V-01/02", "ZYR-A-31", "KB-A-59".
 *
 * Most of the suite labels its tests this way and it is the only stable handle a case keeps once its
 * prose has been edited in Tesbo, so it is the primary match key below.
 */
const SPEC_ID_RE = /^([A-Z]{2,4}(?:-[A-Z])?-\d+[0-9A-Za-z/-]*)\s+(.*)$/;

function splitSpecId(title: string): { id: string | null; body: string } {
  const m = SPEC_ID_RE.exec(title);
  return m ? { id: m[1], body: m[2] } : { id: null, body: title };
}

/**
 * Title text reduced to something comparable across the two sides.
 *
 * Drops a trailing "[ID]", the "Verify that " / "Verify " lead-in this project's cases are phrased
 * with, and all punctuation and case. Used only as the FALLBACK key, for the tests that carry no id.
 */
function normalizeTitle(title: string): string {
  return (title ?? "")
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .replace(/^verify that\s+/i, "")
    .replace(/^verify\s+/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface StageIndex {
  byId: Set<string>;
  byText: Set<string>;
  total: number;
}

/**
 * What the project already holds, indexed so a re-run adds only what is genuinely new.
 *
 * NOT keyed on `suiteId::title`, which an earlier version of this script used and which is unsafe
 * here for two independent reasons, both observed against the stage project on 2026-08-18:
 *
 *   1. The 885 cases already there have been re-phrased into this project's house style —
 *      "THM-04 exactly one of the two buttons reads as pressed" is stored as
 *      "Verify that exactly one of the two buttons reads as pressed [THM-04]". A raw title compare
 *      matches none of them.
 *   2. Their suites are Title Case ("Knowledge Base"), while `suiteNameFor` produced lower case
 *      ("knowledge base"), so every suite would have been created a second time and the whole tree
 *      duplicated alongside itself.
 *
 * Keying on the id, and falling back to normalized prose, survives both. (automationPath /
 * automationTestName would be the ideal key and cannot be used: `GET /testcases` does not project
 * those columns — only automationStatus and automationTags survive the list projection.)
 */
async function stageIndex(suites: Array<{ id: string }>): Promise<StageIndex> {
  const byId = new Set<string>();
  const byText = new Set<string>();
  const seenIds = new Set<string>();

  /*
   * Read per suite rather than by offset.
   *
   * `?limit=500&offset=N` is NOT a stable window here: paging the project three times returned 1106
   * rows carrying only 1086 distinct ids — 20 rows duplicated across pages and 20 others never
   * returned at all, because the list has no deterministic tie-break for rows sharing a sort value.
   * An index built that way silently omits cases, and every omission becomes a duplicate on the next
   * push. Partitioning by suite keeps each request well inside one page and cannot skip a row.
   */
  const scopes = [...suites.map((s) => `suiteId=${s.id}`), "suiteId=none"];
  for (const scope of scopes) {
    const rows: TesboCase[] = await api(
      "GET",
      `/api/projects/${PROJECT_ID}/testcases?limit=500&${scope}`,
    );
    if (rows.length >= 500) {
      throw new Error(
        `A suite returned ${rows.length} cases, at or past the page ceiling (${scope}). ` +
          `Paging would be needed here and this index does not do it — split the suite or add paging.`,
      );
    }
    for (const row of rows) {
      if (seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      const tag = /\[([^\]]+)\]\s*$/.exec(row.title ?? "");
      if (tag) byId.add(tag[1].trim());
      byText.add(normalizeTitle(row.title ?? ""));
    }
  }

  // The project's own total, so an index that came back short fails loudly instead of duplicating.
  const head = await fetch(`${BASE_URL}/api/projects/${PROJECT_ID}/testcases?limit=1`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const reported = Number(head.headers.get("x-total-count") ?? "0");
  if (reported && seenIds.size < reported) {
    throw new Error(
      `Indexed ${seenIds.size} test cases but the project reports ${reported}. ` +
        `Pushing now would duplicate the ${reported - seenIds.size} it could not see.`,
    );
  }

  return { byId, byText, total: seenIds.size };
}

/**
 * Every wording this spec could already be stored under.
 *
 * Two forms exist in the project, and both have to be recognised or the push duplicates them:
 *
 *   "Verify that <title> [ID]"        — for a test carrying an id
 *   "Verify <describe path> <title>"  — for one that does not, e.g.
 *                                       "Verify test suite CRUD supports create -> list -> rename"
 *
 * The second is why the describe path is folded in: without it the stored key keeps the describe
 * words and the spec's own key does not, so 13 CRUD cases matched nothing and would have been
 * created a second time.
 */
function candidateKeys(spec: PlaywrightSpec): string[] {
  const { body } = splitSpecId(spec.title);
  const context = spec.suitePath.join(" ");
  const keys = [normalizeTitle(body)];
  if (context) keys.push(normalizeTitle(`${context} ${body}`));
  return keys;
}

/** True when this spec is already recorded in the project, under either wording. */
function alreadyOnStage(index: StageIndex, spec: PlaywrightSpec): boolean {
  const { id } = splitSpecId(spec.title);
  if (id && index.byId.has(id)) return true;
  return candidateKeys(spec).some((key) => index.byText.has(key));
}

/**
 * Suites matched by name within a parent, CASE-INSENSITIVELY, so re-runs reuse the tree.
 *
 * The case folding is the point: the project's suites are Title Case and this script generates the
 * same names, but a rename in the UI ("knowledge base" → "Knowledge Base") must not cause a second
 * suite to appear beside the first. Matching on the folded name means either spelling resolves to
 * whatever is already there.
 */
async function suiteTree(): Promise<Map<string, string>> {
  const suites: Array<{ id: string; name: string; parentId: string | null }> = await api(
    "GET",
    `/api/projects/${PROJECT_ID}/suites`,
  );
  const byKey = new Map<string, string>();
  for (const s of suites) byKey.set(`${s.parentId ?? "root"}::${s.name.trim().toLowerCase()}`, s.id);
  return byKey;
}

async function ensureSuite(
  tree: Map<string, string>,
  name: string,
  parentId: string | null,
): Promise<string> {
  const key = `${parentId ?? "root"}::${name.trim().toLowerCase()}`;
  const found = tree.get(key);
  if (found) return found;

  if (DRY_RUN) {
    const fake = `dry-run-${key}`;
    tree.set(key, fake);
    return fake;
  }

  const created = await api("POST", `/api/projects/${PROJECT_ID}/suites`, { name, parentId });
  tree.set(key, created.id);
  return created.id;
}

/* ─────────────────────────────── mapping ─────────────────────────────── */

/**
 * "api/knowledge-base.spec.ts" → "Knowledge Base" — the spec file is the unit a suite maps to.
 *
 * Title Case to match the suites the project already has. `ensureSuite` folds case before comparing,
 * so this only decides how a NEW suite is spelled; it can never split an existing one.
 */
function suiteNameFor(spec: PlaywrightSpec): string {
  return path
    .basename(spec.file)
    .replace(/\.spec\.ts$/, "")
    .split("-")
    .filter(Boolean)
    .map((word) => (word.toLowerCase() === "rbac" ? "RBAC" : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
}

/**
 * The house style the project's existing 885 cases are written in:
 *
 *   "THM-04 exactly one of the two buttons reads as pressed"
 *     → "Verify that exactly one of the two buttons reads as pressed [THM-04]"
 *
 * The id moves to the end in brackets, which is also what `stageIndex` keys on — so a case pushed
 * today is recognised on the next run even if somebody rewrites its prose in the UI afterwards.
 */
function caseTitle(spec: PlaywrightSpec): string {
  const { id, body } = splitSpecId(spec.title);
  if (id) return `Verify that ${body} [${id}]`.replace(/\s+/g, " ").trim();

  // No id: fold in the describe path the way the project's own CRUD cases do, because these titles
  // are usually verb fragments ("supports create -> list -> rename") that read as nothing on their
  // own. "Verify test suite CRUD supports create -> list -> rename".
  const context = spec.suitePath.join(" ").trim();
  return (context ? `Verify ${context} ${body}` : `Verify that ${body}`).replace(/\s+/g, " ").trim();
}

function caseBody(spec: PlaywrightSpec, suiteId: string, repo: string) {
  const testName = [...spec.suitePath, spec.title].join(" › ");
  const automationPath = `e2e/${spec.file}`;
  const project = spec.file.startsWith("ui/") ? "ui" : "api";

  return {
    suiteId,
    title: caseTitle(spec),
    description:
      `Automated in \`${automationPath}:${spec.line}\`.\n\n` +
      (spec.suitePath.length ? `Playwright suite: ${spec.suitePath.join(" › ")}\n\n` : "") +
      `This case is generated from the Playwright suite by scripts/push-to-tesbo.ts. ` +
      `Edit the spec, not this description — a re-run does not overwrite it.`,
    type: "Functional",
    priority: "P2",
    automationStatus: "Automated",
    automationFramework: "Playwright",
    automationRepo: repo,
    automationPath,
    automationTestName: testName,
    automationTags: project,
    steps: [],
  };
}

/* ─────────────────────────────── the run ─────────────────────────────── */

async function main(): Promise<void> {
  console.log(`Reading the Playwright suite…`);
  const specs = readSuite();
  console.log(`  ${specs.length} tests in ${new Set(specs.map((s) => s.file)).size} files\n`);

  // The idempotency key is (spec file → suite, title). If two tests in one file ever share a title,
  // the second would look like the first on a re-run and silently never be created. Fail here
  // instead: it is a one-word fix in the spec, and undetectable once it reaches Tesbo.
  const pairs = new Map<string, number>();
  for (const s of specs) {
    const k = `${s.file}::${s.title}`;
    pairs.set(k, (pairs.get(k) ?? 0) + 1);
  }
  const collisions = [...pairs].filter(([, n]) => n > 1);
  if (collisions.length) {
    console.error(`${collisions.length} test title(s) are duplicated within their spec file:`);
    for (const [k, n] of collisions.slice(0, 20)) console.error(`  ×${n}  ${k}`);
    console.error(`\nRename them — the push keys on (file, title) and cannot tell these apart.`);
    process.exit(1);
  }

  console.log(`Target: ${BASE_URL}  project ${PROJECT_ID}${DRY_RUN ? "  (dry run)" : ""}`);
  // The suite list is fetched first because stageIndex() partitions its read by suite.
  const rawSuites: Array<{ id: string; name: string; parentId: string | null }> = await api(
    "GET",
    `/api/projects/${PROJECT_ID}/suites`,
  );
  const tree = new Map<string, string>();
  for (const s of rawSuites) tree.set(`${s.parentId ?? "root"}::${s.name.trim().toLowerCase()}`, s.id);
  const seen = await stageIndex(rawSuites);
  console.log(
    `  ${seen.total} test cases already in the project ` +
      `(${seen.byId.size} carrying a [ID] tag), ${tree.size} suites\n`,
  );

  const repo = repoUrl();
  const rootIds = new Map<string, string>();
  let created = 0;
  let skipped = 0;
  const failures: Array<{ title: string; error: string }> = [];

  for (const spec of specs) {
    // Checked BEFORE the suite is touched, so a run that has nothing to add creates no suites either.
    if (alreadyOnStage(seen, spec)) {
      skipped++;
      continue;
    }

    const projectName = spec.file.startsWith("ui/") ? "UI" : "API";
    if (!rootIds.has(projectName)) {
      rootIds.set(projectName, await ensureSuite(tree, projectName, null));
    }
    const suiteId = await ensureSuite(tree, suiteNameFor(spec), rootIds.get(projectName)!);

    // Guards against two specs in this run reducing to the same case.
    for (const key of candidateKeys(spec)) seen.byText.add(key);
    const { id } = splitSpecId(spec.title);
    if (id) seen.byId.add(id);

    if (DRY_RUN) {
      created++;
      continue;
    }

    try {
      await api("POST", `/api/projects/${PROJECT_ID}/testcases`, caseBody(spec, suiteId, repo));
      created++;
    } catch (error) {
      failures.push({ title: spec.title, error: String(error).slice(0, 200) });
    }
  }

  console.log(`${DRY_RUN ? "Would create" : "Created"}: ${created}`);
  console.log(`Already present, left alone: ${skipped}`);
  if (failures.length) {
    console.log(`\nFailed: ${failures.length}`);
    for (const f of failures.slice(0, 20)) console.log(`  ${f.title}\n    ${f.error}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
