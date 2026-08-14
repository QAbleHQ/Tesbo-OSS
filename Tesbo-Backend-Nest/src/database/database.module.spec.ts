import { AppConfigService } from "../config/app-config.service";
import { poolOptions } from "./database.module";

/*
 * The pool's timeout wiring.
 *
 * This lives in a unit test rather than in e2e on purpose: statement_timeout is a per-connection GUC,
 * and Postgres gives no way for one session to read another session's setting, so an end-to-end caller
 * cannot observe it without a debug endpoint that would exist only for the test. What e2e *can* prove
 * — that the pool still serves concurrent traffic and doesn't leak connections — is covered in
 * e2e/api/transport.spec.ts. This covers the half e2e can't reach.
 */

function configWith(env: Record<string, string>): AppConfigService {
  const original = { ...process.env };
  // AppConfigService reads process.env in field initialisers, so the env has to be in place before
  // construction and restored after — a plain `new AppConfigService()` per test would otherwise leak
  // settings into the next one.
  Object.assign(process.env, env);
  try {
    return new AppConfigService();
  } finally {
    for (const key of Object.keys(env)) {
      if (key in original) process.env[key] = original[key];
      else delete process.env[key];
    }
  }
}

describe("database pool options", () => {
  it("caps every statement server-side so one slow query cannot hold a connection open", () => {
    const options = poolOptions(configWith({}));
    expect(options.statement_timeout).toBe(30_000);
  });

  it("bounds how long a caller waits for a free connection instead of queueing forever", () => {
    const options = poolOptions(configWith({}));
    expect(options.connectionTimeoutMillis).toBe(10_000);
  });

  it("caps a transaction left idle between BEGIN and COMMIT", () => {
    const options = poolOptions(configWith({}));
    expect(options.idle_in_transaction_session_timeout).toBe(60_000);
  });

  it("retires idle connections rather than holding the full pool at peak forever", () => {
    const options = poolOptions(configWith({}));
    expect(options.idleTimeoutMillis).toBe(30_000);
  });

  it("defaults the pool above the previous hardcoded 10", () => {
    const options = poolOptions(configWith({}));
    expect(options.max).toBe(20);
  });

  it("takes every limit from the environment so a deployment can budget against max_connections", () => {
    const options = poolOptions(
      configWith({
        DB_POOL_MAX: "5",
        DB_STATEMENT_TIMEOUT_MS: "1234",
        DB_CONNECTION_TIMEOUT_MS: "2345",
        DB_IDLE_TIMEOUT_MS: "3456",
        DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: "4567",
      })
    );
    expect(options).toMatchObject({
      max: 5,
      statement_timeout: 1234,
      connectionTimeoutMillis: 2345,
      idleTimeoutMillis: 3456,
      idle_in_transaction_session_timeout: 4567,
    });
  });

  it("treats 0 as 'no timeout' so a long migration or backfill can opt out", () => {
    // Postgres reads 0 for both GUCs as disabled. This is the documented escape hatch — asserted so
    // that a later refactor to `|| DEFAULT` (which would silently swallow 0) fails here.
    const options = poolOptions(configWith({ DB_STATEMENT_TIMEOUT_MS: "0", DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: "0" }));
    expect(options.statement_timeout).toBe(0);
    expect(options.idle_in_transaction_session_timeout).toBe(0);
  });

  it("falls back to the defaults when the environment holds something non-numeric", () => {
    const options = poolOptions(configWith({ DB_POOL_MAX: "lots", DB_STATEMENT_TIMEOUT_MS: "" }));
    expect(options.max).toBe(20);
    expect(options.statement_timeout).toBe(30_000);
  });
});
