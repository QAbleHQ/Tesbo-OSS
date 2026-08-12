import { execFileSync } from "node:child_process";
import { env } from "./env";

/*
 * Raw Postgres access for suites that have to arrange or tear down state the API can't reach.
 *
 * Transport is `docker compose exec postgres psql`, so this only works where the compose stack is
 * reachable from wherever the tests run. dbControlAvailable() probes for that once per worker so
 * callers can skip cleanly against a remote target instead of failing mid-suite.
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

function run(sql: string, extraArgs: string[] = []): string {
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
      "-U",
      env.dbUser,
      "-d",
      env.dbName,
      "-v",
      "ON_ERROR_STOP=1",
      ...extraArgs,
      "-c",
      sql,
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** Runs SQL for its effect. Throws (via ON_ERROR_STOP) if Postgres rejects it. */
export function exec(sql: string): void {
  run(sql);
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
