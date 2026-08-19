/*
 * Coverage report — replaces the shell one-liners in docs/e2e-coverage-waves.md §1.
 *
 * Two counters, both machine-checkable:
 *
 *   API route coverage — distinct controller paths (method + path) referenced by at least one spec
 *   UI page coverage   — Tesbo-Frontend/app/**\/page.tsx routes visited by at least one spec
 *
 * Why a script rather than the one-liners: the one-liners have been wrong twice. Once because the
 * `:` was missing from a character class, which truncated every spec URL at its first interpolated
 * id so nothing matched a `:param` declaration; and once because a spec that builds its URL from a
 * base variable (`${base}/definitions/${id}/options`) is invisible to a grep anchored at `/api`.
 * This resolves both: it walks the controllers for the real declarations, and it resolves
 * single-level string constants inside a spec before matching.
 *
 * Usage:
 *   cd e2e && npx tsx scripts/coverage-report.ts            # the summary tables
 *   npx tsx scripts/coverage-report.ts --uncovered          # every uncovered path/page, grouped
 *   npx tsx scripts/coverage-report.ts --min-api 90 --min-ui 90   # non-zero exit below threshold
 *   npx tsx scripts/coverage-report.ts --audit              # every route + the specs that cover it
 *   npx tsx scripts/coverage-report.ts --json               # machine-readable, for CI
 *
 * There is no tsx or ts-node in devDependencies, and none is needed — Node strips the types:
 *   node --experimental-strip-types scripts/coverage-report.ts        (Node 22+)
 * `npm run coverage` in e2e/ wraps that.
 */

import fs from "node:fs";
import path from "node:path";

/*
 * The repo root is found by walking up from the cwd rather than from __dirname, because this file
 * has to run under both module systems: tsconfig.json compiles the suite as commonjs (so `tsc
 * --noEmit` typechecks it that way), while Node's type-stripping sees the `import` statements and
 * loads it as ESM — where __dirname does not exist. Looking for the backend directory is true under
 * either, and from any subdirectory.
 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "Tesbo-Backend-Nest"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not find the repo root above ${process.cwd()} — run this from inside the repository.`,
  );
}

const repoRoot = findRepoRoot();
const backendSrc = path.join(repoRoot, "Tesbo-Backend-Nest/src");
const frontendApp = path.join(repoRoot, "Tesbo-Frontend/app");
const e2eRoot = path.join(repoRoot, "e2e");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function walk(dir: string, match: (f: string) => boolean, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(full, match, out);
    } else if (match(full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Normalises a path so a declaration and a spec URL can be compared.
 *
 * Every parameter segment — `:id`, `:projectId`, or an interpolated `${projectId}` — collapses to
 * `:x`, because which name a route gives its parameter is not a coverage fact.
 */
function normalizePath(p: string): string {
  // Interpolations are collapsed FIRST, and the order is load-bearing: a nullish-coalescing default
  // inside one (`${projectId ?? tenant!.mainProjectId}`) contains a literal `?`, so stripping the
  // query string first truncates the path at the interpolation and silently merges every route in
  // the file into one bucket. That is exactly how a 107-test Knowledge Base suite measured as six
  // covered paths.
  let out = p.replace(/\$\{[^}]*\}/g, ":x");
  out = out.split("?")[0].split("#")[0];
  out = out.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":x"); // :id, :projectId
  out = out.replace(/\/+/g, "/");
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

// ---------------------------------------------------------------------------
// API side — what the controllers declare
// ---------------------------------------------------------------------------

export interface RouteDecl {
  method: string;
  route: string; // normalised, e.g. GET /api/projects/:x/suites
  file: string;
  area: string;
}

const METHODS = ["Get", "Post", "Put", "Patch", "Delete", "Head", "Options", "All"];

/**
 * The area a route belongs to, used only for grouping the gap table. Derived from the first
 * meaningful path segment, with the sub-resource kept where the first segment is a generic
 * container (`/api/projects/:x/knowledge-base/...` is Knowledge Base, not Projects).
 */
function areaOf(route: string): string {
  const p = route.replace(/^[A-Z]+ /, "");
  const segs = p.split("/").filter((s) => s && s !== "api");
  const named = segs.filter((s) => s !== ":x");
  const joined = named.join("/");

  if (/^knowledge-base|^kb\b/.test(joined) || joined.includes("knowledge-base")) return "Knowledge Base";
  if (/zyra|agent|ai-|rag|embedding|mcp|chat/.test(joined)) return "Zyra / AI / MCP";
  if (/integration|jira|linear/.test(joined)) return "Integrations";
  if (/billing|subscription|checkout|plan/.test(joined)) return "Billing & plans";
  if (/report|analytic|dashboard|insight|trend/.test(joined)) return "Reports & analytics";
  if (/attachment|upload|file/.test(joined)) return "Attachments & storage";
  if (/import|export|template/.test(joined)) return "Import / export";
  if (/custom-field/.test(joined)) return "Custom fields";
  if (/auth|login|signup|otp|password|verify|session/.test(joined)) return "Auth";
  if (/invitation|invite|member|project-access|role/.test(joined)) return "Members & access";
  if (/notification|activity|audit/.test(joined)) return "Notifications & activity";
  if (/apikey|api-token|token/.test(joined)) return "API keys";
  if (/admin|setup|health/.test(joined)) return "Admin & health";
  if (/execution|cycle|run|schedule|share/.test(joined)) return "Execution & runs";
  if (/testcase|suite|component|requirement|bug|defect/.test(joined)) return "Repository";
  if (/workspace|onboarding|organization/.test(joined)) return "Workspace";
  if (/project/.test(joined)) return "Projects";
  return "Other";
}

export function declaredRoutes(): RouteDecl[] {
  const files = walk(backendSrc, (f) => f.endsWith(".controller.ts"));
  const seen = new Map<string, RouteDecl>();

  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");

    // A @Controller("prefix") contributes its prefix to every route in the class. Most of this
    // codebase declares full paths on the method and leaves @Controller() bare, but auth, billing,
    // setup and admin do use a prefix — miss it and those routes look uncovered forever.
    const prefixMatch = src.match(/@Controller\(\s*["'`]([^"'`]*)["'`]\s*\)/);
    const prefix = prefixMatch ? prefixMatch[1] : "";

    const re = new RegExp(`@(${METHODS.join("|")})\\(\\s*(?:["'\`]([^"'\`]*)["'\`])?\\s*\\)`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const method = m[1].toUpperCase();
      const declared = m[2] ?? "";
      const joined = declared.startsWith("/api") ? declared : `${prefix}/${declared}`;
      const route = normalizePath(joined);
      if (!route.startsWith("/api")) continue; // not an HTTP surface we count
      const key = `${method} ${route}`;
      if (!seen.has(key)) {
        seen.set(key, {
          method,
          route,
          file: path.relative(repoRoot, file),
          area: areaOf(route),
        });
      }
    }
  }
  return [...seen.values()].sort((a, b) => (a.route + a.method).localeCompare(b.route + b.method));
}

// ---------------------------------------------------------------------------
// API side — what the specs reference
// ---------------------------------------------------------------------------

/**
 * Every `/api/...` path a spec or util mentions, with URL-builder indirection resolved.
 *
 * The indirection is the whole difficulty. Almost no spec writes a full path at the call site;
 * they write a helper once and a suffix everywhere:
 *
 *     function kbUrl(suffix: string, projectId?: string): string {
 *       return `/api/projects/${projectId ?? tenant!.mainProjectId}/knowledge-base${suffix}`;
 *     }
 *     await api.get(kbUrl("/folders/tree"));
 *
 * A scan that only looks at string literals sees `"/folders/tree"`, which starts with no `/api`, and
 * concludes the route is uncovered — so a file of a hundred passing tests can measure as zero. Two
 * earlier revisions of the shell one-liner had a version of this bug, each undercounting in a
 * direction nobody checked.
 *
 * Three forms are resolved here, to a fixed point so helpers may be built out of other helpers:
 *
 *   1. a constant  — `const base = `/api/projects/${id}/custom-fields``
 *   2. a builder   — a function whose body returns a template starting with /api and ending with
 *                    its own first parameter, so `NAME("/suffix")` is prefix + suffix
 *   3. a re-wrapper — a builder whose body returns a CALL to another builder, e.g.
 *                    `commentsUrl(id) => kbUrl(`/documents/${id}/comments`)`
 *
 * Anything more indirect than that stays invisible, so the figure remains a floor rather than an
 * estimate. --uncovered prints what is missing, and a route that specs really do exercise showing up
 * there means this resolver needs another form, not that the tests are absent.
 */
export interface PathReference {
  /** HTTP verbs seen on this path; "ANY" when the verb could not be read off the call site. */
  methods: Set<string>;
  /** Spec files that reference it, so a coverage claim can be traced back to a test. */
  files: Set<string>;
}

export function referencedPaths(): Map<string, PathReference> {
  const files = [
    ...walk(path.join(e2eRoot, "api"), (f) => f.endsWith(".ts")),
    ...walk(path.join(e2eRoot, "ui"), (f) => f.endsWith(".ts")),
    ...walk(path.join(e2eRoot, "utils"), (f) => f.endsWith(".ts")),
    path.join(e2eRoot, "global-setup.ts"),
  ].filter((f) => fs.existsSync(f));

  /** normalised path -> what references it */
  const hits = new Map<string, PathReference>();
  let currentFile = "";
  const add = (p: string, method: string) => {
    const route = normalizePath(p);
    if (!route.startsWith("/api")) return;
    if (!hits.has(route)) hits.set(route, { methods: new Set(), files: new Set() });
    const entry = hits.get(route)!;
    entry.methods.add(method);
    entry.files.add(currentFile);
  };

  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    currentFile = path.relative(e2eRoot, file);

    /*
     * Two maps, because a URL builder is used in two different ways and only one of them appends.
     *
     *   builders    — what `${name(…)}` resolves to. Always the whole path the builder produces.
     *   appendable  — the subset whose template ENDS with its own first parameter, so a call site's
     *                 string argument is a suffix: `kbUrl("/folders/tree")`.
     *
     * Conflating them is what produced `…/custom-field-valuesnot-a-uuid` (appending an id to a builder
     * whose parameter sits mid-template) and, when that was fixed too bluntly, what broke
     * `${definitionsUrl()}/reorder` (a mid-template-parameter builder still resolves fine under an
     * interpolation). Both uses are legitimate; they just have different rules.
     */
    const builders = new Map<string, string>();
    const appendable = new Map<string, string>();
    /** Templates that are already whole paths, recorded directly. */
    const completePaths = new Set<string>();

    // Form 1: a constant holding an /api path. `${base}/x` expands against it.
    const constRe = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*[`"']((?:\/api)[^`"']*)[`"']/g;
    let cm: RegExpExecArray | null;
    while ((cm = constRe.exec(src))) {
      builders.set(cm[1], cm[2]);
      appendable.set(cm[1], cm[2]);
    }

    // Form 2: a builder returning a template that starts with /api. The trailing `${suffix}` — the
    // interpolation of its own first parameter — is stripped, since the call site supplies it.
    const builderRe =
      /(?:function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)[^{]*\{\s*return\s+`(\/api[^`]*)`|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\(([^)]*)\)[^=]*=>\s*`(\/api[^`]*)`)/g;
    let bm: RegExpExecArray | null;
    while ((bm = builderRe.exec(src))) {
      const name = bm[1] ?? bm[4];
      const params = bm[2] ?? bm[5] ?? "";
      const template = bm[3] ?? bm[6];
      if (!name || !template) continue;
      const prefix = stripTrailingParam(template, firstParamName(params));
      if (prefix !== template) {
        // The template ended with `${suffix}`: a call site's string argument is a suffix.
        builders.set(name, prefix);
        appendable.set(name, prefix);
      } else {
        /*
         * The parameter sits INSIDE the template — `valuesUrl(id) =>
         * `/api/projects/${p}/testcases/${id}/custom-field-values``. The builder still resolves under an
         * interpolation (`${definitionsUrl()}/reorder` is exactly this shape), but a call-site argument
         * is an ID substituted inside it, NOT a suffix — appending it would invent
         * `…/custom-field-valuesnot-a-uuid`.
         */
        builders.set(name, template);
        completePaths.add(template);
      }
    }

    // Form 3: a builder whose body is a call to another builder with a template argument.
    // Resolved to a fixed point, because one may be defined above the other in the file.
    const wrapperRe =
      /(?:function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)[^{]*\{\s*return\s+([A-Za-z_$][\w$]*)\(\s*`([^`]*)`|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\(([^)]*)\)[^=]*=>\s*([A-Za-z_$][\w$]*)\(\s*`([^`]*)`)/g;
    const wrappers: Array<{ name: string; target: string; arg: string; param: string }> = [];
    let wm: RegExpExecArray | null;
    while ((wm = wrapperRe.exec(src))) {
      const name = wm[1] ?? wm[5];
      const params = wm[2] ?? wm[6] ?? "";
      const target = wm[3] ?? wm[7];
      const arg = wm[4] ?? wm[8];
      if (!name || !target || builders.has(name)) continue;
      wrappers.push({ name, target, arg, param: firstParamName(params) });
    }
    /*
     * Form 4: a builder whose template BEGINS with an interpolation of another builder, rather than
     * with /api — `definitionUrl(id) => `${definitionsUrl(projectId)}/${id}``.
     *
     * Form 2 misses it because the template does not start with /api, and Form 3 misses it because the
     * body is a template rather than a bare call. It is the shape every "…Url(id)" helper in the suite
     * takes, so missing it hid the whole custom-field option surface.
     */
    const nestedRe =
      /(?:function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)[^{]*\{\s*return\s+`\$\{([A-Za-z_$][\w$]*)\([^)]*\)\}([^`]*)`|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\(([^)]*)\)[^=]*=>\s*`\$\{([A-Za-z_$][\w$]*)\([^)]*\)\}([^`]*)`)/g;
    let nm: RegExpExecArray | null;
    while ((nm = nestedRe.exec(src))) {
      const name = nm[1] ?? nm[5];
      const params = nm[2] ?? nm[6] ?? "";
      const target = nm[3] ?? nm[7];
      const rest = nm[4] ?? nm[8] ?? "";
      if (!name || !target || builders.has(name)) continue;
      wrappers.push({ name, target, arg: rest, param: firstParamName(params) });
    }

    for (let pass = 0; pass < 5; pass++) {
      for (const w of wrappers) {
        if (builders.has(w.name) || !builders.has(w.target)) continue;
        const resolved = builders.get(w.target)! + stripTrailingParam(w.arg, w.param);
        builders.set(w.name, resolved);
        appendable.set(w.name, resolved);
      }
    }

    /*
     * Loop variables over an array of string literals.
     *
     * `for (const path of ["/tesbo-reports/runs", "/tesbo-reports/specs"]) … api.get(url(path))` is a
     * better test than six unrolled copies, and it was invisible: the builder's argument is an
     * identifier, not a literal. Each value is substituted, so one loop credits every route it visits.
     * Restricted to arrays of plain string literals — anything computed is left alone rather than
     * guessed at.
     */
    const loopValues = new Map<string, string[]>();
    const loopRe = /for\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s*\[([^\]]*)\]/g;
    let lm: RegExpExecArray | null;
    while ((lm = loopRe.exec(src))) {
      const values = [...lm[2].matchAll(/["'`]([^"'`]*)["'`]/g)].map((m) => m[1]);
      if (!values.length) continue;
      const existing = loopValues.get(lm[1]) ?? [];
      loopValues.set(lm[1], [...existing, ...values]);
    }

    /*
     * Matches are ANCHORED on what is being looked for, never on quote pairing.
     *
     * Scanning "every quoted string" pairwise is what the first version of this did, and it is
     * silently wrong on this suite: an apostrophe in prose ("a qa_engineer may edit what they
     * created, but not someone else's") is an unbalanced quote character, so it pairs with the next
     * real one and every string after it in the file is mis-parsed. A file of 56 passing tests
     * measured as six covered routes that way. Anchoring on `/api`, on a builder's name, or on an
     * interpolation means an unbalanced quote elsewhere cannot shift the parse.
     */
    const record = (candidate: string, index: number) => {
      const before = src.slice(Math.max(0, index - 80), index);
      // The verb, read from the call this sits inside — either directly (`api.get("/api/...")`) or
      // through a builder (`api.get(kbUrl("/x"))`).
      const verbMatch = before.match(/\.(get|post|put|patch|delete|head|fetch)\s*\(\s*(?:[A-Za-z_$][\w$]*\(\s*)?$/i);
      const method = verbMatch ? verbMatch[1].toUpperCase() : "ANY";
      add(candidate, method === "FETCH" ? "ANY" : method);
    };

    for (const template of completePaths) record(template, 0);

    // A literal path, in any kind of quote. `/api` must be a whole segment: without the `(?=/|["'`])`
    // lookahead, the suffix string "/apikeys" reads as an /api path and three imaginary routes appear.
    const literalRe = /["'`](\/api(?=\/|["'`])[^"'`\n]*)/g;
    let litMatch: RegExpExecArray | null;
    while ((litMatch = literalRe.exec(src))) record(litMatch[1], litMatch.index);

    // `${base}/definitions` — an interpolation of a known builder at the head of the string.
    const interpRe = /["'`]\$\{([A-Za-z_$][\w$]*)(?:\([^)]*\))?\}([^"'`\n]*)/g;
    let im: RegExpExecArray | null;
    while ((im = interpRe.exec(src))) {
      // isPathSuffix, for the same reason as the call-site form: `${url} should refuse an anonymous
      // upload` is an assertion message whose first token happens to be a path variable, and appending
      // its prose to a real prefix invents a route. A name can be both a const holding a path and a
      // loop variable in the same file, so the shape of the remainder is the only reliable signal.
      if (builders.has(im[1]) && isPathSuffix(im[2])) record(builders.get(im[1])! + im[2], im.index);
    }

    // `kbUrl("/folders/tree")` — the string is a known builder's first argument.
    for (const [name, prefix] of appendable) {
      const callRe = new RegExp(`\\b${name}\\(\\s*["'\`]([^"'\`\\n]*)`, "g");
      let km: RegExpExecArray | null;
      // The argument must look like a path suffix. Without this check, any same-named helper called
      // with a message ("should refuse an anonymous upload") stitches that message onto the prefix and
      // invents a path — which the dangling-reference guard below then reports, correctly.
      while ((km = callRe.exec(src))) if (isPathSuffix(km[1])) record(prefix + km[1], km.index);

      // `url(path)` where `path` is a loop variable over string literals.
      const varCallRe = new RegExp(`\\b${name}\\(\\s*([A-Za-z_$][\\w$]*)\\s*[,)]`, "g");
      let vm: RegExpExecArray | null;
      while ((vm = varCallRe.exec(src))) {
        for (const value of loopValues.get(vm[1]) ?? []) {
          if (isPathSuffix(value)) record(prefix + value, vm.index);
        }
      }
    }

    // `${provider}/status` and `/api/.../${provider}/status` — a loop variable inside a path.
    for (const [variable, values] of loopValues) {
      const interpolatedRe = new RegExp(
        `["'\`]((?:/api|\\$\\{[A-Za-z_$][\\w$]*(?:\\([^)]*\\))?\\})[^"'\`\\n]*\\$\\{${variable}\\}[^"'\`\\n]*)`,
        "g",
      );
      let pm: RegExpExecArray | null;
      while ((pm = interpolatedRe.exec(src))) {
        const raw = pm[1];
        const lead = raw.match(/^\$\{([A-Za-z_$][\w$]*)(?:\([^)]*\))?\}(.*)$/);
        // Same path-suffix rule as the other forms, and it matters most here: `${url} should refuse an
        // anonymous upload` is an assertion MESSAGE that happens to begin with an interpolation, and a
        // loop variable can share a name with a builder in the same file (`url`), so without this the
        // message body gets stitched onto a real prefix and 18 imaginary routes appear.
        const base = lead
          ? builders.has(lead[1]) && isPathSuffix(lead[2])
            ? builders.get(lead[1])! + lead[2]
            : null
          : raw;
        if (!base) continue;
        for (const value of values) {
          record(base.split("${" + variable + "}").join(value), pm.index);
        }
      }
    }
  }
  return hits;
}

/**
 * Whether a call-site argument can be appended to a builder's prefix.
 *
 * A path suffix is empty or starts with `/` (or with an interpolation that will resolve to a segment).
 * Anything else — an assertion message, a bare id, a label — is a different kind of argument, and
 * appending it fabricates a route that exists nowhere.
 */
function isPathSuffix(value: string): boolean {
  return value === "" || value.startsWith("/") || value.startsWith("?");
}

/** The first parameter's name, ignoring its type annotation and default. */
function firstParamName(params: string): string {
  const first = params.split(",")[0] ?? "";
  return (first.split(":")[0] ?? "").replace(/[?=].*$/, "").trim();
}

/**
 * A builder's template with its own trailing `${suffix}` removed, and every other interpolation
 * collapsed to `:x`.
 *
 * The trailing interpolation is the caller's argument, which the call site supplies; leaving it in
 * would turn every route into `.../knowledge-base/:x` and merge two dozen distinct paths into one.
 */
function stripTrailingParam(template: string, paramName: string): string {
  let out = template;
  if (paramName) {
    const trailing = new RegExp("\\$\\{" + paramName + "\\}$");
    out = out.replace(trailing, "");
  }
  return out;
}

// ---------------------------------------------------------------------------
// UI side
// ---------------------------------------------------------------------------

export interface PageDecl {
  route: string; // normalised, e.g. /projects/:x/knowledge-base
  file: string;
}

/** Next.js app-router pages, with route groups and dynamic segments resolved. */
export function declaredPages(): PageDecl[] {
  const files = walk(frontendApp, (f) => /\/page\.tsx$/.test(f));
  const pages: PageDecl[] = [];
  for (const file of files) {
    const rel = path.relative(frontendApp, path.dirname(file));
    const segs = rel
      .split(path.sep)
      .filter((s) => s && s !== ".")
      .filter((s) => !(s.startsWith("(") && s.endsWith(")"))) // route groups don't appear in URLs
      .map((s) => (/^\[.*\]$/.test(s) ? ":x" : s));
    const route = "/" + segs.join("/");
    pages.push({ route: route === "/" ? "/" : route.replace(/\/$/, ""), file: path.relative(repoRoot, file) });
  }
  return pages.sort((a, b) => a.route.localeCompare(b.route));
}

/** Every web path a UI spec navigates to or asserts a URL against. */
export function visitedPages(): Set<string> {
  const files = walk(path.join(e2eRoot, "ui"), (f) => f.endsWith(".ts")).concat(
    walk(path.join(e2eRoot, "utils"), (f) => f.endsWith(".ts")),
  );
  const visited = new Set<string>();

  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");

    // Anchored on the leading `/`, not on quote pairing — an apostrophe in prose would otherwise shift
    // every subsequent match, which is the bug that made the API counter read six covered paths (§0).
    const pathRe = /["'`](\/[^"'`\n]*)/g;
    let pm: RegExpExecArray | null;
    while ((pm = pathRe.exec(src))) {
      const raw = pm[1];
      if (raw.startsWith("/api")) continue; // the other counter's business
      visited.add(normalizePath(raw));
    }

    /*
     * Loop variables, the same way the API side handles them.
     *
     * `for (const provider of ["jira", "linear"]) … goto(`/settings/integrations/${provider}`)` visits
     * two screens, and collapsing the interpolation to `:x` credits neither — `/settings/integrations/:x`
     * matches no declared page, because both are literal directories in the app router.
     */
    const loopValues = new Map<string, string[]>();
    const loopRe = /for\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s*\[([^\]]*)\]/g;
    let lm: RegExpExecArray | null;
    while ((lm = loopRe.exec(src))) {
      const values = [...lm[2].matchAll(/["'`]([^"'`]*)["'`]/g)].map((m) => m[1]);
      if (values.length) loopValues.set(lm[1], values);
    }
    for (const [variable, values] of loopValues) {
      const interpolatedRe = new RegExp(
        `["'\`](/[^"'\`\\n]*\\$\\{${variable}\\}[^"'\`\\n]*)`,
        "g",
      );
      let im: RegExpExecArray | null;
      while ((im = interpolatedRe.exec(src))) {
        if (im[1].startsWith("/api")) continue;
        for (const value of values) {
          visited.add(normalizePath(im[1].split("${" + variable + "}").join(value)));
        }
      }
    }

    // Regex literals in toHaveURL assertions: /\/projects\/[^/]+\/testcases/
    const reRe = /toHaveURL\(\s*\/([^/\n]*(?:\\\/[^/\n]*)*)\//g;
    let rm: RegExpExecArray | null;
    while ((rm = reRe.exec(src))) {
      const body = rm[1]
        .replace(/\\\//g, "/")
        .replace(/\[\^\/\]\+|\[\^\/\]\*|\.\+|\.\*|\\w\+|\[a-f0-9-\]\+/g, ":x")
        .replace(/[$^]/g, "");
      if (body.startsWith("/")) visited.add(normalizePath(body));
    }
  }
  return visited;
}

/**
 * Pages that are deliberately not counted, from docs/e2e-coverage-waves.md §1.
 *
 * Declared here rather than left implicit so "out of scope" is a decision in version control
 * instead of an accident of what nobody got to.
 */
const OUT_OF_SCOPE_PAGES = [
  "/privacy-policy",
  "/terms-and-conditions",
  "/setup",
  "/integrations/callback",
];


// ---------------------------------------------------------------------------
// Matching a referenced URL to a declared route
// ---------------------------------------------------------------------------

/**
 * Attributes each referenced path to the declared route a router would dispatch it to.
 *
 * Equality is not enough in either direction. A spec often uses a CONCRETE value where the route
 * declares a parameter — `/api/workspace/integrations/jira/auth-url` against
 * `/api/workspace/integrations/:x/auth-url` — so those must match. But a wildcard must not swallow a
 * sibling literal route: `/api/projects/:x/knowledge-base/folders` has to count as the `folders`
 * route, not as `/api/projects/:x/knowledge-base/:itemId`, or one reference would mark two distinct
 * endpoints covered and the Knowledge Base's param route would look tested when nothing touched it.
 *
 * So each referenced path is attributed to its MOST LITERAL match — fewest wildcard segments — which
 * is the same rule Nest applies when it declares the literal routes above the parameter one.
 */
export function coveredRoutePatterns(declared: string[], referenced: Iterable<string>): Set<string> {
  const bySegmentCount = new Map<number, string[]>();
  for (const route of declared) {
    const n = route.split("/").length;
    if (!bySegmentCount.has(n)) bySegmentCount.set(n, []);
    bySegmentCount.get(n)!.push(route);
  }

  const covered = new Set<string>();
  for (const ref of referenced) {
    const refSegs = ref.split("/");
    let best: string | null = null;
    let bestWildcards = Number.POSITIVE_INFINITY;
    for (const candidate of bySegmentCount.get(refSegs.length) ?? []) {
      const candSegs = candidate.split("/");
      let wildcards = 0;
      let matches = true;
      for (let i = 0; i < candSegs.length; i++) {
        if (candSegs[i] === refSegs[i]) continue;
        // Either side may be the wildcard: the declared route has `:x` where it takes a parameter,
        // and the spec has `:x` wherever it interpolated an id.
        if (candSegs[i] === ":x" || refSegs[i] === ":x") {
          wildcards++;
          continue;
        }
        matches = false;
        break;
      }
      if (matches && wildcards < bestWildcards) {
        best = candidate;
        bestWildcards = wildcards;
      }
    }
    if (best) covered.add(best);
  }
  return covered;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface Args {
  uncovered: boolean;
  json: boolean;
  minApi: number | null;
  minUi: number | null;
  area: string | null;
  /** Print every declared route with the spec files that reference it. */
  audit: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { uncovered: false, json: false, minApi: null, minUi: null, area: null, audit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--uncovered") args.uncovered = true;
    else if (a === "--audit") args.audit = true;
    else if (a === "--json") args.json = true;
    else if (a === "--min-api") args.minApi = Number(argv[++i]);
    else if (a === "--min-ui") args.minUi = Number(argv[++i]);
    else if (a === "--area") args.area = argv[++i];
  }
  return args;
}

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${Math.round((n / d) * 100)}%`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const routes = declaredRoutes();
  const hits = referencedPaths();

  // A route counts as covered when some spec references a URL that would dispatch to it. Method-level
  // agreement is reported separately rather than folded in: `ANY` shows up whenever the verb couldn't
  // be read off the call site, and treating that as a miss would undercount real coverage.
  const coveredRoutes = coveredRoutePatterns(
    routes.map((r) => r.route),
    hits.keys(),
  );
  const covered = routes.filter((r) => coveredRoutes.has(r.route));
  const uncoveredRoutes = routes.filter((r) => !coveredRoutes.has(r.route));

  const pages = declaredPages().filter((p) => !OUT_OF_SCOPE_PAGES.includes(p.route));
  const visited = visitedPages();
  const coveredPageRoutes = coveredRoutePatterns(
    pages.map((p) => p.route),
    visited,
  );
  const coveredPages = pages.filter((p) => coveredPageRoutes.has(p.route));
  const uncoveredPages = pages.filter((p) => !coveredPageRoutes.has(p.route));

  // Distinct paths, which is the counter the tracker doc quotes, alongside method-level routes.
  const declaredPathSet = new Set(routes.map((r) => r.route));
  const coveredPathSet = new Set(covered.map((r) => r.route));

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          api: {
            paths: { covered: coveredPathSet.size, total: declaredPathSet.size },
            routes: { covered: covered.length, total: routes.length },
            uncovered: uncoveredRoutes.map((r) => `${r.method} ${r.route}`),
          },
          ui: {
            pages: { covered: coveredPages.length, total: pages.length },
            uncovered: uncoveredPages.map((p) => p.route),
          },
        },
        null,
        2,
      ),
    );
  } else {
    console.log("\nE2E coverage\n============\n");
    console.log(
      `API paths   ${coveredPathSet.size} / ${declaredPathSet.size}  (${pct(coveredPathSet.size, declaredPathSet.size)})`,
    );
    console.log(
      `API routes  ${covered.length} / ${routes.length}  (${pct(covered.length, routes.length)})   [method + path]`,
    );
    console.log(`UI pages    ${coveredPages.length} / ${pages.length}  (${pct(coveredPages.length, pages.length)})`);

    // The gap, by area, so a wave can be picked by size rather than by guess.
    const byArea = new Map<string, { covered: number; total: number }>();
    for (const r of routes) {
      const e = byArea.get(r.area) ?? { covered: 0, total: 0 };
      e.total++;
      if (coveredRoutes.has(r.route)) e.covered++;
      byArea.set(r.area, e);
    }
    console.log("\nBy area (method + path)\n");
    const rows = [...byArea.entries()].sort((a, b) => b[1].total - b[1].covered - (a[1].total - a[1].covered));
    const width = Math.max(...rows.map(([a]) => a.length));
    for (const [area, e] of rows) {
      const gap = e.total - e.covered;
      const bar = "█".repeat(Math.round((e.covered / e.total) * 20)).padEnd(20, "·");
      console.log(
        `  ${area.padEnd(width)}  ${bar}  ${String(e.covered).padStart(3)}/${String(e.total).padEnd(3)}  ${pct(e.covered, e.total).padStart(4)}  gap ${gap}`,
      );
    }

    if (args.uncovered) {
      console.log("\nUncovered API routes\n");
      const grouped = new Map<string, RouteDecl[]>();
      for (const r of uncoveredRoutes) {
        if (args.area && r.area !== args.area) continue;
        if (!grouped.has(r.area)) grouped.set(r.area, []);
        grouped.get(r.area)!.push(r);
      }
      for (const [area, list] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`  ${area} (${list.length})`);
        for (const r of list) console.log(`    ${r.method.padEnd(6)} ${r.route}`);
        console.log("");
      }
      console.log(`Uncovered UI pages (${uncoveredPages.length})\n`);
      for (const p of uncoveredPages) console.log(`    ${p.route}`);
      console.log("");
    }
  }

  /*
   * The integrity guard on the resolver itself.
   *
   * A referenced path that matches NO declared route is either a resolver mistake (a prefix stitched
   * together wrongly) or a spec calling a route that does not exist. Both matter: the first inflates
   * coverage, the second is a test that cannot be testing what it claims. Reported unconditionally,
   * because a coverage tool that can only over-count in silence is the thing this file exists to stop.
   */
  const declaredSet = new Set(routes.map((r) => r.route));
  const dangling = [...hits.entries()].filter(([route]) => {
    if (declaredSet.has(route)) return false;
    return coveredRoutePatterns([...declaredSet], [route]).size === 0;
  });
  if (!args.json && dangling.length) {
    console.log(`\n⚠ ${dangling.length} referenced path(s) match no declared route:\n`);
    for (const [route, ref] of dangling.slice(0, 20)) {
      console.log(`    ${route}  ← ${[...ref.files].join(", ")}`);
    }
    console.log(
      "\n  Each is either a resolver bug (an over-count) or a spec calling a route that does not exist.\n",
    );
  }

  if (args.audit && !args.json) {
    // Which spec backs each route, so a 100% claim can be checked rather than believed.
    console.log("\nRoute → the spec files that reference it\n");
    const byRoute = new Map<string, Set<string>>();
    for (const [refPath, ref] of hits) {
      for (const declared of coveredRoutePatterns([...declaredSet], [refPath])) {
        if (!byRoute.has(declared)) byRoute.set(declared, new Set());
        for (const f of ref.files) byRoute.get(declared)!.add(f);
      }
    }
    for (const route of [...declaredSet].sort()) {
      const files = byRoute.get(route);
      console.log(`  ${files ? "✓" : "✗"} ${route}`);
      if (files) console.log(`      ${[...files].sort().join(", ")}`);
    }
    console.log("");
  }

  let failed = false;
  if (args.minApi !== null) {
    const p = (coveredPathSet.size / declaredPathSet.size) * 100;
    if (p < args.minApi) {
      console.error(`API path coverage ${p.toFixed(1)}% is below the ${args.minApi}% threshold`);
      failed = true;
    }
  }
  if (args.minUi !== null) {
    const p = (coveredPages.length / pages.length) * 100;
    if (p < args.minUi) {
      console.error(`UI page coverage ${p.toFixed(1)}% is below the ${args.minUi}% threshold`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
}

main();
