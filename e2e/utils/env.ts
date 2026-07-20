import path from "node:path";

function isLocalHost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:1011";
const webBaseUrl = process.env.WEB_BASE_URL ?? "http://localhost:1010";

export const env = {
  apiBaseUrl,
  webBaseUrl,
  ci: !!process.env.CI,

  // Disposable smoke-test account. On a fresh stack this user doesn't exist yet —
  // global-setup creates it automatically when autoProvision is enabled (see below).
  testEmail: process.env.E2E_TEST_EMAIL ?? "e2e-smoke@tesbo.local",
  testPassword: process.env.E2E_TEST_PASSWORD ?? "E2eSmokeTest!2026",
  testName: process.env.E2E_TEST_NAME ?? "E2E Smoke User",

  orgName: process.env.E2E_ORG_NAME ?? "E2E Smoke Org",
  projectName: process.env.E2E_PROJECT_NAME ?? "E2E Smoke Project",

  // Signup requires an OTP. When the target looks local, global-setup tries two ways to get
  // one without a human in the loop, in order: (1) sign up over the real API and scrape the
  // OTP out of `docker compose logs` — works when no Postmark token is configured, since the
  // backend then just console.logs the code instead of emailing it; (2) if that doesn't turn
  // up a code within a few seconds (e.g. a real POSTMARK_API_TOKEN is set, so the code went
  // out as an actual email instead), seed the user directly into Postgres with a correctly
  // hashed password, bypassing OTP delivery entirely. Against a remote target, pre-create the
  // user yourself and either leave this unset (it defaults to false there) or set it to false.
  autoProvision: process.env.E2E_AUTO_PROVISION
    ? process.env.E2E_AUTO_PROVISION === "true"
    : isLocalHost(apiBaseUrl),
  dockerComposeFile:
    process.env.E2E_DOCKER_COMPOSE_FILE ?? path.resolve(__dirname, "../../docker-compose.yml"),
  dockerService: process.env.E2E_DOCKER_SERVICE ?? "backend",
  dbService: process.env.E2E_DB_SERVICE ?? "postgres",
  dbUser: process.env.E2E_DB_USER ?? process.env.POSTGRES_USER ?? "postgres",
  dbName: process.env.E2E_DB_NAME ?? process.env.POSTGRES_DB ?? "tesbo",
};
