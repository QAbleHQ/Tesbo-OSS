import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { PG_POOL } from "./database.tokens";

/**
 * The pg-pool failures that mean "no usable connection", as opposed to "your statement was wrong".
 *
 * They are matched on message because pg-pool constructs them with `new Error(...)` and gives them
 * no `code`, unlike a server-side error which always carries a SQLSTATE. Each is a distinct
 * mechanism and they are worth telling apart when reading a log:
 *
 *  - `timeout exceeded when trying to connect` — every client is checked out and this caller sat in
 *    the waiter queue past connectionTimeoutMillis. This is genuine pool exhaustion: `max` is too
 *    low for the offered concurrency, or something is holding connections.
 *  - `Connection terminated due to connection timeout` — the pool tried to open a NEW client and the
 *    handshake did not finish inside the same budget, so pg-pool destroyed the socket. That is a
 *    slow or unavailable upstream (for us, the Neon pooler), not saturation of `max`.
 *  - `Connection terminated unexpectedly` — an established connection went away underneath an
 *    in-flight statement.
 *
 * All three are the server failing to reach its database, which is a 503: the request was valid and
 * retrying it later may well work. Reporting them as 500 `Internal server error` — or, worse,
 * letting them read as a transport fault — hides a capacity problem behind what looks like a bug in
 * the endpoint the caller happened to hit.
 */
const CONNECTION_FAILURE_MESSAGES = [
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
  "Connection terminated unexpectedly"
] as const;

function isConnectionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return CONNECTION_FAILURE_MESSAGES.some((known) => message.includes(known));
}

@Injectable()
export class DatabaseService {
  private readonly logger = new Logger(DatabaseService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Turns a connection-acquisition failure into a 503 that says what happened, and logs the pool
   * census alongside it. The census is the whole point: `waiting > 0` with `idle = 0` says the pool
   * is exhausted and `max` needs raising, while `waiting = 0` says the upstream is refusing new
   * connections — the same error message, two opposite fixes, and no way to tell them apart after
   * the fact without these three numbers.
   */
  private rethrow(error: unknown): never {
    if (!isConnectionFailure(error)) throw error;
    const { totalCount, idleCount, waitingCount } = this.pool;
    this.logger.error(
      `database connection unavailable (pool total=${totalCount} idle=${idleCount} waiting=${waitingCount}): ` +
        `${(error as Error).message}`
    );
    throw new ServiceUnavailableException({
      error: "The database is not accepting connections right now. Please retry in a moment."
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = []
  ): Promise<QueryResult<T>> {
    try {
      return await this.pool.query<T>(text, values);
    } catch (error) {
      this.rethrow(error);
    }
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      this.rethrow(error);
    }
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      // A ROLLBACK on a connection that has already died throws in its own right. Letting that
      // escape replaced the real failure with "Connection terminated unexpectedly", so the cause of
      // every transaction lost to a dropped connection was the rollback, never the original error.
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        this.logger.warn(`ROLLBACK failed after a transaction error: ${(rollbackError as Error).message}`);
      }
      this.rethrow(error);
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
