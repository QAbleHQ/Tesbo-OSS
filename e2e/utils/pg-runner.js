"use strict";

/*
 * A one-shot, synchronously-callable Postgres client.
 *
 * utils/psql.ts exposes a SYNCHRONOUS API — exec(), scalar(), column() are called inline by ~46
 * spec files — while node-postgres is asynchronous. Rather than convert every call site to await
 * (and every helper that wraps them), this script is spawned with execFileSync: the parent blocks,
 * this process connects, runs the SQL, prints the result and exits. One connection per statement,
 * which is exactly what `psql -c` did before it.
 *
 * Why this exists at all: the previous transport was `docker compose exec postgres psql`, using the
 * local compose container purely to supply the psql binary and a network path. That works on a
 * developer's machine and nowhere else — a CI runner pointed at a staging database has no such
 * container, so every DB-backed fixture skipped and 46 of 60 spec files went dark. This path needs
 * neither Docker nor a psql binary, so the same code runs locally and in CI.
 *
 * Protocol: argv[2] is the connection string, argv[3] is the SQL. Rows are written to stdout in the
 * format `psql -At` produced — one row per line, the first column only, NULL as an empty string —
 * because that is the contract psql.ts's callers were written against.
 */

const { Client } = require("pg");

// A parent that stops reading (an aborted run, a killed worker) closes this pipe under us. Writing
// to it then raises EPIPE on the stdout stream, which node turns into an unhandled 'error' event and
// a crash dump — noise that reads like a database fault but isn't one. Nothing useful remains to be
// said at that point, so exit quietly.
process.stdout.on("error", (error) => {
  if (error && error.code === "EPIPE") process.exit(0);
  throw error;
});

const [, , connectionString, sql] = process.argv;

if (!connectionString || sql === undefined) {
  process.stderr.write("pg-runner: expected <connectionString> <sql>\n");
  process.exit(2);
}

/*
 * Return every column as the raw text the wire carried, instead of letting pg coerce it to a JS
 * type. This keeps the helpers byte-identical to `psql -At`: an int8 count arrives as "3" not 3, a
 * boolean as "t" not true, and a timestamptz as Postgres's own rendering rather than a JS Date
 * stringified some other way. Assertions in the existing specs compare against those exact strings,
 * so type coercion here would break them in ways that look like product bugs.
 */
const rawText = { getTypeParser: () => (value) => value };

/*
 * Neon requires TLS and the URL carries `sslmode=require`. node-postgres understands sslmode from
 * the connection string, but not libpq's `channel_binding` parameter, which it harmlessly ignores.
 * rejectUnauthorized is left at pg's default for the sslmode given — this is not the place to
 * silently weaken certificate checking.
 */
const client = new Client({ connectionString });

async function main() {
  await client.connect();
  try {
    // Simple query protocol: `sql` may contain several statements, in which case pg answers with an
    // array of results. The last one that carries rows is the one a scalar()/column() caller means.
    const result = await client.query({ text: sql, rowMode: "array", types: rawText });
    const results = Array.isArray(result) ? result : [result];

    let rows = [];
    for (const r of results) {
      if (r && Array.isArray(r.rows) && r.rows.length > 0) rows = r.rows;
    }

    // First column only, NULL as "" — `psql -At` with a single-column SELECT.
    const out = rows.map((row) => (row[0] === null || row[0] === undefined ? "" : String(row[0])));
    if (out.length > 0) process.stdout.write(out.join("\n") + "\n");
  } finally {
    await client.end();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    // The message must reach stderr intact: execAllowingAuditImmutability() in psql.ts matches
    // /audit_logs is append-only/ against it to tell an expected teardown refusal from a real fault.
    process.stderr.write(String((error && error.message) || error) + "\n");
    process.exit(1);
  },
);
