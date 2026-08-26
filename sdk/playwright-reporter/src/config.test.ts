import assert from "node:assert/strict";
import { test } from "node:test";
import { ENV_BASE_URL, ENV_PROJECT_ID, ENV_TOKEN, maskToken, normalizeBaseUrl, resolveConfig } from "./config";

const PROJECT = "41dba2a2-a60b-4917-8d63-9f8a86986703";
const TOKEN = "tsbo_f89c09aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function env(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...over };
}

/* ─────────────────────────────── the three states ─────────────────────────────── */

test("resolves all three values from the environment", () => {
  const result = resolveConfig(
    {},
    env({ [ENV_BASE_URL]: "https://api-app-stage.tesbo.io", [ENV_PROJECT_ID]: PROJECT, [ENV_TOKEN]: TOKEN })
  );
  assert.equal(result.state, "ok");
  if (result.state !== "ok") return;
  assert.deepEqual(result.config, {
    baseUrl: "https://api-app-stage.tesbo.io",
    projectId: PROJECT,
    token: TOKEN
  });
});

test("inline options win over the environment", () => {
  const result = resolveConfig(
    { baseUrl: "https://inline.example.com", projectId: PROJECT, token: TOKEN },
    env({ [ENV_BASE_URL]: "https://from-env.example.com", [ENV_PROJECT_ID]: "other", [ENV_TOKEN]: "other" })
  );
  assert.equal(result.state, "ok");
  if (result.state !== "ok") return;
  assert.equal(result.config.baseUrl, "https://inline.example.com");
  assert.equal(result.config.projectId, PROJECT);
});

test("nothing set at all is an opt-out, not a failure", () => {
  const result = resolveConfig({}, env());
  assert.equal(result.state, "unconfigured");
});

/*
 * The distinction that fixes the silent-success bug. A missing token with the other two set is a
 * secret that did not reach the runner, never a deliberate choice — so it must not be reported the
 * same way as "no Tesbo configured".
 */
test("a partially set configuration is incomplete, never unconfigured", () => {
  const result = resolveConfig({}, env({ [ENV_BASE_URL]: "https://api.example.com", [ENV_PROJECT_ID]: PROJECT }));
  assert.equal(result.state, "incomplete");
  if (result.state !== "incomplete") return;
  assert.deepEqual(result.missing, [ENV_TOKEN]);
});

test("each single missing value is named, so the message is actionable", () => {
  const noProject = resolveConfig({}, env({ [ENV_BASE_URL]: "https://api.example.com", [ENV_TOKEN]: TOKEN }));
  assert.equal(noProject.state, "incomplete");
  if (noProject.state === "incomplete") assert.deepEqual(noProject.missing, [ENV_PROJECT_ID]);

  const noBase = resolveConfig({}, env({ [ENV_PROJECT_ID]: PROJECT, [ENV_TOKEN]: TOKEN }));
  assert.equal(noBase.state, "incomplete");
  if (noBase.state === "incomplete") assert.deepEqual(noBase.missing, [ENV_BASE_URL]);
});

test("whitespace-only values count as unset", () => {
  const result = resolveConfig({}, env({ [ENV_BASE_URL]: "   ", [ENV_PROJECT_ID]: "\t", [ENV_TOKEN]: " " }));
  assert.equal(result.state, "unconfigured");
});

test("values are trimmed — a trailing newline from a CI secret must not reach the header", () => {
  const result = resolveConfig(
    {},
    env({ [ENV_BASE_URL]: " https://api.example.com \n", [ENV_PROJECT_ID]: ` ${PROJECT}\n`, [ENV_TOKEN]: `${TOKEN}\n` })
  );
  assert.equal(result.state, "ok");
  if (result.state !== "ok") return;
  assert.equal(result.config.token, TOKEN);
  assert.equal(result.config.projectId, PROJECT);
});

/* ─────────────────────────────── the baseUrl regression ─────────────────────────────── */

/*
 * The bug this pins: `baseUrl` used to default to "https://app.tesbo.io", which is the web app, not
 * the API. The frontend has no /api rewrite, so every ingest call 404'd — and because the client
 * logs failures instead of throwing, the suite stayed green and no results appeared. A default that
 * cannot work for anyone is worse than no default.
 */
test("baseUrl has no default — it is never silently assumed", () => {
  const result = resolveConfig({ projectId: PROJECT, token: TOKEN }, env());
  assert.equal(result.state, "incomplete");
  if (result.state !== "incomplete") return;
  assert.deepEqual(result.missing, [ENV_BASE_URL]);
});

test("no resolution ever produces an app.tesbo.io base url on its own", () => {
  for (const input of [{}, { projectId: PROJECT }, { token: TOKEN }, { projectId: PROJECT, token: TOKEN }]) {
    const result = resolveConfig(input, env());
    assert.notEqual(result.state, "ok", `${JSON.stringify(input)} must not resolve without a base url`);
  }
});

/* ─────────────────────────────── normalizeBaseUrl ─────────────────────────────── */

test("a bare origin passes through untouched", () => {
  const result = normalizeBaseUrl("https://api.example.com");
  assert.equal(result.origin, "https://api.example.com");
  assert.deepEqual(result.notes, []);
});

test("trailing slashes are stripped", () => {
  assert.equal(normalizeBaseUrl("https://api.example.com///").origin, "https://api.example.com");
});

test("a trailing /api is trimmed, because the client appends it", () => {
  const result = normalizeBaseUrl("https://api.example.com/api");
  assert.equal(result.origin, "https://api.example.com");
  assert.match(result.notes.join(" "), /Trimmed the trailing \/api/);
});

/*
 * Pasting the MCP URL out of Project Settings is the most likely thing a new user does, since it is
 * the one place the product shows them a full URL. It carries the project id, so it configures two
 * values at once.
 */
test("the MCP URL from Project Settings yields both the origin and the project id", () => {
  const result = normalizeBaseUrl(`https://api-app-stage.tesbo.io/api/projects/${PROJECT}/mcp`);
  assert.equal(result.origin, "https://api-app-stage.tesbo.io");
  assert.equal(result.inferredProjectId, PROJECT);
});

test("the inferred project id fills a gap but never overrides an explicit one", () => {
  const filled = resolveConfig(
    { baseUrl: `https://api.example.com/api/projects/${PROJECT}/mcp`, token: TOKEN },
    env()
  );
  assert.equal(filled.state, "ok");
  if (filled.state === "ok") assert.equal(filled.config.projectId, PROJECT);

  const explicit = resolveConfig(
    { baseUrl: `https://api.example.com/api/projects/${PROJECT}/mcp`, projectId: "explicit-wins", token: TOKEN },
    env()
  );
  assert.equal(explicit.state, "ok");
  if (explicit.state !== "ok") return;
  assert.equal(explicit.config.projectId, "explicit-wins");
  assert.match(explicit.notes.join(" "), /using explicit-wins/);
});

test("a non-uuid in the project position is not mistaken for a project id", () => {
  const result = normalizeBaseUrl("https://api.example.com/api/projects/not-a-uuid/mcp");
  assert.equal(result.origin, "https://api.example.com");
  assert.equal(result.inferredProjectId, undefined);
});

test("the web app host is flagged, since that mistake fails invisibly", () => {
  for (const host of ["https://app.tesbo.io", "https://app-stage.tesbo.io"]) {
    const result = normalizeBaseUrl(host);
    assert.equal(result.origin, host, "still usable — a self-hosted install may serve both from one host");
    assert.match(result.notes.join(" "), /looks like the web app host/);
  }
});

test("an API host is not flagged", () => {
  const result = normalizeBaseUrl("https://api-app-stage.tesbo.io");
  assert.equal(result.notes.join(" ").includes("web app host"), false);
});

test("a missing scheme is rejected rather than guessed at", () => {
  const result = normalizeBaseUrl("api-app-stage.tesbo.io");
  assert.equal(result.origin, null);
  assert.match(result.error ?? "", /must start with http/);
});

test("a non-http scheme is rejected", () => {
  assert.equal(normalizeBaseUrl("ftp://api.example.com").origin, null);
  assert.equal(normalizeBaseUrl("postgres://localhost:5432").origin, null);
});

test("an unparseable value is an invalid resolution, not a crash", () => {
  const result = resolveConfig({ baseUrl: "https://", projectId: PROJECT, token: TOKEN }, env());
  assert.equal(result.state, "invalid");
});

test("a port and an http scheme both survive, for self-hosted installs", () => {
  assert.equal(normalizeBaseUrl("http://localhost:1021").origin, "http://localhost:1021");
  assert.equal(normalizeBaseUrl("http://192.168.1.10:8080/api").origin, "http://192.168.1.10:8080");
});

/* ─────────────────────────────── maskToken ─────────────────────────────── */

test("a masked token shows which token it is without being usable", () => {
  const masked = maskToken(TOKEN);
  assert.match(masked, /^tsbo_f89c/);
  assert.equal(masked.includes(TOKEN), false);
  assert.equal(masked.length < TOKEN.length, true);
});

test("a short token is masked entirely rather than mostly revealed", () => {
  assert.equal(maskToken("tsbo_short"), "…");
});
