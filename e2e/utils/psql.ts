import { execFileSync } from "node:child_process";
import path from "node:path";
import { env } from "./env";

/*
 * Raw Postgres access for suites that have to arrange or tear down state the API can't reach.
 *
 * Transport is a direct node-postgres connection (utils/pg-runner.js), falling back to
 * `docker compose exec postgres psql` where the database is only reachable from inside the compose
 * network — see transport() below. Neither needs anything of the target beyond its connection
 * string, so the same helpers work against a local stack and a deployed one.
 * dbControlAvailable() probes once per worker so callers can skip cleanly when no database was
 * configured at all, instead of failing mid-suite.
 *
 * Every consumer is destructive by nature. Point these at disposable tenants only — never at the
 * shared smoke workspace (account A), which the rest of the suite assumes nobody is mutating.
 *
 * The SQL goes in as an argv element (`psql -c`), NOT down stdin, and via execFileSync rather than a
 * shell. That is deliberate and load-bearing: piping SQL into `docker compose exec -T` is not safe
 * when several Playwright workers shell out at once — the piped stdin can be dropped, at which point
 * psql exits 0 having run nothing at all. A write silently became a no-op and a read silently
 * became "", so fixtures appeared to be applied when they weren't and assertions failed somewhere
 * unrelated, in a different test on each run. Passing argv removes the failure mode entirely.
 */

/*
 * The connection string every helper here goes through — always the stack's own DATABASE_URL.
 *
 * Refusing to run is the whole point. The compose file defines no postgres service, but an orphan
 * container is still listening with its own populated copy of the schema, so a `-U postgres -d
 * tesbo` fallback CONNECTS: it answers SELECT 1, returns plausible rows, and reports a database the
 * API has never written to. dbControlAvailable() then says true, fixtures land somewhere the API
 * cannot see, and suites fail later with "Provisioned <user> but the follow-up password login still
 * failed" — which reads like an auth bug. A hard error here costs one confusing line instead of an
 * afternoon. See the database rule at the top of the repo's CLAUDE.md.
 */
function connectionString(): string {
  if (env.dbUrl) return env.dbUrl;
  throw new Error(
    "e2e psql helpers need the stack's DATABASE_URL and found none. Set DATABASE_URL (or " +
      "E2E_DATABASE_URL) to the value the backend under test is booted from — the repo-root .env " +
      "carries it. There is deliberately no local-postgres fallback: it would connect to the wrong " +
      "database and silently pass.",
  );
}

/*
 * How the SQL actually reaches Postgres. Two transports, same contract.
 *
 * "direct"  — utils/pg-runner.js, a one-shot node-postgres client spawned per statement. Needs
 *             nothing but the connection string, so it works on a developer's machine and on a CI
 *             runner identically. This is the default, and deliberately so: CI must not be the
 *             first place a transport gets exercised.
 * "docker"  — the original `docker compose exec postgres psql`, kept as a fallback for a stack
 *             whose database is only reachable from inside the compose network. The container is
 *             transport only; the database is always connectionString().
 *
 * Set E2E_DB_TRANSPORT=direct|docker to pin one. Pinning "direct" is worth doing in CI, where a
 * silent fall back to a Docker that isn't there would turn a broken connection string into 46
 * quietly skipped spec files instead of a loud failure.
 */
type Transport = "direct" | "docker";

const PG_RUNNER = path.resolve(__dirname, "pg-runner.js");

function runDirect(sql: string): string {
  // The connection string and the SQL both go in as argv elements, never down stdin — see the
  // argv-not-stdin note above, which cost a day of phantom no-op writes to establish.
  //
  // --no-warnings because pg 8.23 prints a nine-line SSL deprecation notice to stderr on every
  // connection (`sslmode=require` is currently treated as `verify-full`). One statement's worth is
  // noise; a suite's worth buries the one line that matters, and stderr is what
  // execAllowingAuditImmutability() reads to tell an expected refusal from a real fault.
  return execFileSync(process.execPath, ["--no-warnings", PG_RUNNER, connectionString(), sql], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runViaDocker(sql: string, extraArgs: string[] = []): string {
  return execFileSync(
    "docker",
    [
      "compose",
      "-f",
      env.dockerComposeFile,
      "exec",
      "-T",
      env.dbService,
      "psql",
      connectionString(),
      "-v",
      "ON_ERROR_STOP=1",
      ...extraArgs,
      "-c",
      sql,
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

let transportChoice: Transport | null = null;

function transport(): Transport {
  if (transportChoice) return transportChoice;

  const pinned = process.env.E2E_DB_TRANSPORT;
  if (pinned === "direct" || pinned === "docker") {
    transportChoice = pinned;
    return transportChoice;
  }

  // Probe once per worker. A direct connection is preferred whenever it works; Docker is only for
  // the case where the database is not reachable from this host at all.
  try {
    runDirect("SELECT 1;");
    transportChoice = "direct";
  } catch {
    transportChoice = "docker";
  }
  return transportChoice;
}

function run(sql: string, extraArgs: string[] = []): string {
  return transport() === "direct" ? runDirect(sql) : runViaDocker(sql, extraArgs);
}

/** Runs SQL for its effect. Throws (via ON_ERROR_STOP) if Postgres rejects it. */
export function exec(sql: string): void {
  run(sql);
}

/**
 * Runs several statements over ONE connection, for their effect.
 *
 * Worth reaching for in any teardown that issues more than a couple of statements, because on a
 * hosted database the connection — not the query — is what costs. Measured against this stack's Neon
 * instance:
 *
 *     connecting                        ~3400ms
 *     one more query, same connection     ~294ms
 *     five statements in one call         ~376ms
 *
 * So five separate exec() calls spend ~17s where one execMany() spends ~3.8s. That is what pushed
 * api/signup.spec.ts's afterAll past the 120s hook budget: purgeAccount() ran five statements per
 * account across ~15 accounts, and the arithmetic (15 × 5 × ~2.5s ≈ 187s) never fit, on either
 * transport. Batching fixes the cause; raising the timeout would only have hidden it.
 *
 * ONE TRANSACTIONAL CAVEAT, and it is the reason this is not simply applied everywhere: the
 * statements share a single simple-query call, so a failure part-way through abandons the rest.
 * Don't batch a statement whose failure is expected and tolerated — in particular anything that can
 * trip the append-only audit_logs trigger, which is what execAllowingAuditImmutability() is for.
 * Keep those as their own call.
 */
export function execMany(statements: string[]): void {
  const batch = statements.map((s) => s.trim()).filter(Boolean);
  if (batch.length === 0) return;
  run(batch.map((s) => (s.endsWith(";") ? s : `${s};`)).join("\n"));
}

/**
 * Runs a teardown statement, tolerating ONLY the append-only audit_logs trigger.
 *
 * `audit_logs` is tamper-evident by design: migration V62_audit_logs_immutable.sql installs a trigger
 * that rejects UPDATE and DELETE for every role, and revokes those grants from the app role as a second
 * layer. Its foreign keys to projects/organizations/users are all ON DELETE SET NULL — so Postgres
 * answers `DELETE FROM users`/`organizations`/`projects` by trying to NULL the audit reference, the
 * trigger rejects that UPDATE, and the delete fails with:
 *
 *   ERROR: audit_logs is append-only: UPDATE is not permitted
 *
 * The consequence is deliberate and not a bug: once anything has been audited against a row, that row
 * can never be hard-deleted. The product agrees — deleteProject archives (`archived_at`) and logs a
 * `project_deleted` entry rather than removing anything. Fixtures have to live with the same rule.
 *
 * So cleanup is attempted and this ONE error is swallowed: un-audited fixture rows (an abandoned signup,
 * an org that never saw an action) still delete cleanly, and audited ones are simply left behind instead
 * of exploding in afterAll and leaving the whole workspace dirty for the next test in the file — which
 * is what turned a handful of un-deletable rows into ~127 failures across unrelated specs.
 *
 * Every other error still throws. A teardown that fails for a real reason must not be silent.
 */
export function execAllowingAuditImmutability(sql: string): void {
  try {
    run(sql);
  } catch (error) {
    const text = `${(error as { stderr?: unknown })?.stderr ?? ""}${(error as Error)?.message ?? ""}`;
    if (!/audit_logs is append-only/.test(text)) throw error;
  }
}

/** Runs a single-row, single-column SELECT and returns it as raw text ("" for NULL). */
export function scalar(sql: string): string {
  return run(sql, ["-At"]).trim();
}

/** Runs a single-column SELECT and returns one entry per row (empty array for no rows). */
export function column(sql: string): string[] {
  const rows = scalar(sql);
  return rows ? rows.split("\n").filter(Boolean) : [];
}

export function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

/** Renders a JS value as a SQL literal. Strings are quoted and escaped; null becomes NULL. */
export function literal(value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return `'${escapeSql(value)}'`;
}

let dbControlProbe: boolean | null = null;

/**
 * Whether these helpers can actually reach Postgres.
 *
 * Cached, because it runs once per worker process and shelling out to docker isn't free.
 */
export function dbControlAvailable(): boolean {
  if (dbControlProbe !== null) return dbControlProbe;
  try {
    dbControlProbe = scalar("SELECT 1;") === "1";
  } catch {
    dbControlProbe = false;
  }
  return dbControlProbe;
}
