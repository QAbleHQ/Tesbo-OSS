import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";
import { encryptSecret, isEncryptedSecret } from "../common/crypto.util";

// One-off backfill: encrypts pre-existing plaintext secrets in integration_oauth_configs.client_secret
// and integration_connections.access_token/refresh_token. Not a schema migration (src/database/migrate.ts
// only executes plain .sql files with no access to Node's crypto/env-sourced key) -- run manually once per
// environment via `npm run backfill:encrypt-secrets`. Idempotent: skips any value that's already encrypted,
// so it's safe to re-run or to run while the app is live.

const BACKFILL_LOCK_KEY = 87261043;

function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else {
    dotenv.config();
  }
}

function normalizeDatabaseUrl(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("jdbc:postgresql://")) return value.slice("jdbc:".length);
  if (value.startsWith("jdbc:postgres://")) return value.slice("jdbc:".length);
  return value;
}

async function main() {
  loadEnv();
  const databaseUrl = normalizeDatabaseUrl(process.env.DATABASE_URL ?? "postgresql://localhost:5432/tesbo");
  const pool = new Pool({
    connectionString: databaseUrl,
    user: process.env.DATABASE_USER || undefined,
    password: process.env.DATABASE_PASSWORD || undefined,
    max: 1
  });

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [BACKFILL_LOCK_KEY]);

    const configs = await client.query<{ organization_id: string; provider: string; client_secret: string }>(
      "SELECT organization_id, provider, client_secret FROM integration_oauth_configs"
    );
    let configsEncrypted = 0;
    for (const row of configs.rows) {
      if (isEncryptedSecret(row.client_secret)) continue;
      await client.query(
        "UPDATE integration_oauth_configs SET client_secret = $1 WHERE organization_id = $2 AND provider = $3",
        [encryptSecret(row.client_secret), row.organization_id, row.provider]
      );
      configsEncrypted++;
    }

    const connections = await client.query<{ id: string; access_token: string; refresh_token: string }>(
      "SELECT id, access_token, refresh_token FROM integration_connections"
    );
    let connectionsEncrypted = 0;
    for (const row of connections.rows) {
      if (isEncryptedSecret(row.access_token) && isEncryptedSecret(row.refresh_token)) continue;
      await client.query(
        "UPDATE integration_connections SET access_token = $1, refresh_token = $2 WHERE id = $3",
        [encryptSecret(row.access_token), encryptSecret(row.refresh_token), row.id]
      );
      connectionsEncrypted++;
    }

    console.log(`Encrypted ${configsEncrypted} oauth config secret(s), ${connectionsEncrypted} connection row(s).`);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [BACKFILL_LOCK_KEY]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
