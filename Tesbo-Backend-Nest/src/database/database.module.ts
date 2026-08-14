import { Global, Module, OnApplicationShutdown } from "@nestjs/common";
import { Pool } from "pg";
import { AppConfigService } from "../config/app-config.service";
import { DatabaseService } from "./database.service";
import { PG_POOL } from "./database.tokens";

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => {
        const pool = new Pool({
          connectionString: config.databaseUrl,
          user: config.databaseUser || undefined,
          password: config.databasePassword || undefined,
          max: 10,
          // Neon's pooler resets connections left idle for a few minutes; recycle ours first so
          // a query never lands on a connection the far end has already killed (surfaces as ECONNRESET).
          idleTimeoutMillis: 30_000
        });
        // Without this handler, an error on an idle pooled client (e.g. the far end resetting it)
        // is an unhandled 'error' event and crashes the process instead of just dropping that client.
        pool.on("error", (error) => console.error("PG pool idle client error:", error));
        return pool;
      }
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
