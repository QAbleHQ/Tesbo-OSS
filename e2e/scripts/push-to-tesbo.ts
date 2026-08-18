/*
 * Pushes this Playwright suite into a Tesbo project as automated test cases.
 *
 * Tesbo manages its own regression suite: every `test()` in e2e/ becomes a test case, linked back to
 * the spec that implements it through the automation_* columns createTestCase already carries. The
 * suite tree mirrors the folder layout — one parent suite per Playwright project (API / UI), one
 * child suite per spec file.
 *
 * The source of truth stays in e2e/. This script only reflects it, so it is safe to re-run: a test
 * case is matched on (automationPath, automationTestName) and left alone if it already exists.
 * Nothing is ever deleted — a spec removed from the repo leaves its case behind for a human to
 * retire, because deleting test cases would take their execution history with them.
 *
 *   TESBO_BASE_URL=https://stage.example.com \
 *   TESBO_TOKEN=tesbo_xxx \
 *   TESBO_PROJECT_ID=<uuid> \
 *   npx tsx scripts/push-to-tesbo.ts --dry-run
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
const REPO_ROOT = path.resolve(__dirname, "../..");

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
    cwd: path.resolve(__dirname, ".."),
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
 * Every existing case, keyed `suiteId::title`, so a re-run can tell what it already pushed.
 *
 * The obvious key would be (automationPath, automationTestName) — that is what actually identifies a
 * spec. It can't be used: `GET /testcases` does NOT project the automation_* columns (only
 * automationStatus and automationTags survive the list projection; the rest come back only from
 * `GET /testcases/:id`). Keying on them here would read null for every row, find nothing, and
 * duplicate the whole suite on the second run.
 *
 * suiteId::title is sound because this script maps one suite per spec file and all 885 (file, title)
 * pairs are distinct — asserted below, so the day that stops being true this fails loudly instead of
 * silently double-creating. Pages at the API's 500 ceiling.
 */
async function existingCases(): Promise<Set<string>> {
  const keys = new Set<string>();
  for (let offset = 0; ; offset += 500) {
    const page: TesboCase[] = await api(
      "GET",
      `/api/projects/${PROJECT_ID}/testcases?limit=500&offset=${offset}`,
    );
    for (const row of page) keys.add(`${row.suiteId ?? "none"}::${row.title}`);
    if (page.length < 500) return keys;
  }
}

/** Suites are matched by name within a parent, so re-runs reuse the tree instead of duplicating it. */
async function suiteTree(): Promise<Map<string, string>> {
  const suites: Array<{ id: string; name: string; parentId: string | null }> = await api(
    "GET",
    `/api/projects/${PROJECT_ID}/suites`,
  );
  const byKey = new Map<string, string>();
  for (const s of suites) byKey.set(`${s.parentId ?? "root"}::${s.name}`, s.id);
  return byKey;
}

async function ensureSuite(
  tree: Map<string, string>,
  name: string,
  parentId: string | null,
): Promise<string> {
  const key = `${parentId ?? "root"}::${name}`;
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

/** "api/knowledge-base.spec.ts" → "knowledge base" — the spec file is the unit a suite maps to. */
function suiteNameFor(spec: PlaywrightSpec): string {
  return path.basename(spec.file).replace(/\.spec\.ts$/, "").replace(/-/g, " ");
}

function caseBody(spec: PlaywrightSpec, suiteId: string, repo: string) {
  const testName = [...spec.suitePath, spec.title].join(" › ");
  const automationPath = `e2e/${spec.file}`;
  const project = spec.file.startsWith("ui/") ? "ui" : "api";

  return {
    suiteId,
    title: spec.title,
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
  const [seen, tree] = await Promise.all([existingCases(), suiteTree()]);
  console.log(`  ${seen.size} test cases already linked to a spec, ${tree.size} suites\n`);

  const repo = repoUrl();
  const rootIds = new Map<string, string>();
  let created = 0;
  let skipped = 0;
  const failures: Array<{ title: string; error: string }> = [];

  for (const spec of specs) {
    // The suite has to be resolved before the existence check, because the key is scoped to it.
    // Creating a suite is itself idempotent, so this costs nothing on a re-run.
    const projectName = spec.file.startsWith("ui/") ? "UI" : "API";
    if (!rootIds.has(projectName)) {
      rootIds.set(projectName, await ensureSuite(tree, projectName, null));
    }
    const suiteId = await ensureSuite(tree, suiteNameFor(spec), rootIds.get(projectName)!);

    if (seen.has(`${suiteId}::${spec.title}`)) {
      skipped++;
      continue;
    }

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
