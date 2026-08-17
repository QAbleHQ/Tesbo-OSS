import { Global, Module, OnApplicationShutdown } from "@nestjs/common";
import { Pool, type PoolConfig } from "pg";
import { AppConfigService } from "../config/app-config.service";
import { DatabaseService } from "./database.service";
import { PG_POOL } from "./database.tokens";

/**
 * The pool every request goes through.
 *
 * Exported separately from the provider so the timeout wiring is assertable without standing up a
 * Nest container — a pool with no statement timeout is invisible until the day it takes the instance
 * down, so it's worth a test that reads the options rather than trusting the call site.
 *
 * The two `*_timeout` keys are Postgres GUCs that node-postgres forwards as connection parameters,
 * not pg options — they act server-side, which is the point: a client-side `query_timeout` abandons
 * the query but leaves it running on the server, still holding its backend.
 */
export function poolOptions(config: AppConfigService): PoolConfig {
  return {
    connectionString: config.databaseUrl,
    user: config.databaseUser || undefined,
    password: config.databasePassword || undefined,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    idleTimeoutMillis: config.databaseIdleTimeoutMs,
    statement_timeout: config.databaseStatementTimeoutMs,
    idle_in_transaction_session_timeout: config.databaseIdleInTransactionTimeoutMs
  };
}

export function buildPool(config: AppConfigService): Pool {
  const pool = new Pool(poolOptions(config));
  // An idle client erroring (a server-side disconnect, a cancelled statement) emits on the pool.
  // Without a listener Node treats it as an unhandled 'error' event and kills the process — so the
  // very protection added here would become a crash under the load it exists to survive.
  pool.on("error", (error) => {
    console.error("[db] idle client error", error.message);
  });
  return pool;
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => buildPool(config)
    },
    DatabaseService
  ],
  exports: [PG_POOL, DatabaseService]
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(private readonly database: DatabaseService) {}

  async onApplicationShutdown() {
    await this.database.close();
  }
}
