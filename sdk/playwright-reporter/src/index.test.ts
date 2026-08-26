import assert from "node:assert/strict";
import { test } from "node:test";
import type { FullConfig, Suite } from "@playwright/test/reporter";
import TesboReporter from "./index";
import { ENV_BASE_URL, ENV_PROJECT_ID, ENV_TOKEN } from "./config";

const PROJECT = "41dba2a2-a60b-4917-8d63-9f8a86986703";
const TOKEN = "tsbo_f89c09aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE = "https://api-app-stage.tesbo.io";

/** Minimal stand-ins: every assertion below is reached before the suite or config is inspected. */
const fakeConfig = { shard: null } as unknown as FullConfig;
const emptySuite = { allTests: () => [] } as unknown as Suite;

/**
 * Runs `body` with the three env vars forced to a known state.
 *
 * Necessary because `resolveConfig` reads `process.env`, and this machine's own shell may export
 * them — a test that passed only because the developer had a token exported would be worthless.
 */
async function withEnv(vars: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
  const names = [ENV_BASE_URL, ENV_PROJECT_ID, ENV_TOKEN];
  const saved = new Map(names.map((n) => [n, process.env[n]]));
  try {
    for (const name of names) {
      const value = vars[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Swallows the reporter's console output so the test log stays readable, and returns what it said. */
async function captureLogs(body: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  console.warn = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    await body();
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
  return lines.join("\n");
}

/* ─────────────────────────── partial config is a hard failure ─────────────────────────── */

/*
 * The behaviour the whole config split exists for. A run that reported nothing while exiting 0 is
 * indistinguishable from a run that reported everything, so a half-configured reporter must stop the
 * suite — with `requireConfig` off, which is the default.
 */
test("a missing token throws at collection time, even with requireConfig off", async () => {
  await withEnv({ [ENV_BASE_URL]: undefined, [ENV_PROJECT_ID]: undefined, [ENV_TOKEN]: undefined }, async () => {
    const reporter = new TesboReporter({ baseUrl: BASE, projectId: PROJECT });
    await assert.rejects(() => reporter.onBegin(fakeConfig, emptySuite), /TESBO_API_TOKEN is missing/);
  });
});

test("a missing base url throws — it is never assumed", async () => {
  await withEnv({ [ENV_BASE_URL]: undefined, [ENV_PROJECT_ID]: undefined, [ENV_TOKEN]: undefined }, async () => {
    const reporter = new TesboReporter({ projectId: PROJECT, token: TOKEN });
    await assert.rejects(() => reporter.onBegin(fakeConfig, emptySuite), /TESBO_BASE_URL is missing/);
  });
});

test("a missing project id throws", async () => {
  await withEnv({ [ENV_BASE_URL]: undefined, [ENV_PROJECT_ID]: undefined, [ENV_TOKEN]: undefined }, async () => {
    const reporter = new TesboReporter({ baseUrl: BASE, token: TOKEN });
    await assert.rejects(() => reporter.onBegin(fakeConfig, emptySuite), /TESBO_PROJECT_ID is missing/);
  });
});

test("an unusable base url throws rather than being retried against all run", async () => {
  await withEnv({ [ENV_BASE_URL]: undefined, [ENV_PROJECT_ID]: undefined, [ENV_TOKEN]: undefined }, async () => {
    const reporter = new TesboReporter({ baseUrl: "not-a-url", projectId: PROJECT, token: TOKEN });
    await assert.rejects(() => reporter.onBegin(fakeConfig, emptySuite), /must start with http/);
  });
});

/* ─────────────────────────── nothing configured is an opt-out ─────────────────────────── */

/*
 * Card §7's case: a fork's pull request build has no secrets and must still be able to run the
 * suite. This is the one state allowed to degrade quietly.
 */
test("nothing configured disables the reporter without failing the suite", async () => {
  await withEnv({ [ENV_BASE_URL]: undefined, [ENV_PROJECT_ID]: undefined, [ENV_TOKEN]: undefined }, async () => {
    const reporter = new TesboReporter();
    const logs = await captureLogs(async () => {
      await reporter.onBegin(fakeConfig, emptySuite);
      await reporter.onEnd({ status: "passed" } as never);
    });
    assert.match(logs, /not configured/);
  });
});

test("requireConfig turns that opt-out into an error", async () => {
  await withEnv({ [ENV_BASE_URL]: undefined, [ENV_PROJECT_ID]: undefined, [ENV_TOKEN]: undefined }, async () => {
    const reporter = new TesboReporter({ requireConfig: true });
    await assert.rejects(() => reporter.onBegin(fakeConfig, emptySuite), /not configured/);
  });
});

test("enabled: false short-circuits before any config is looked at", async () => {
  await withEnv({ [ENV_BASE_URL]: undefined, [ENV_PROJECT_ID]: PROJECT, [ENV_TOKEN]: undefined }, async () => {
    // This env would otherwise be `incomplete` and throw; opting out must win over that.
    const reporter = new TesboReporter({ enabled: false, requireConfig: true });
    await reporter.onBegin(fakeConfig, emptySuite);
  });
});

/* ─────────────────────────── env vars are honoured ─────────────────────────── */

/*
 * Reaches the "no tagged tests" guard, which proves config resolution succeeded from the environment
 * alone and stopped before opening a run — so this test makes no network call.
 */
test("a complete environment resolves, then stops on an untagged suite", async () => {
  await withEnv({ [ENV_BASE_URL]: BASE, [ENV_PROJECT_ID]: PROJECT, [ENV_TOKEN]: TOKEN }, async () => {
    const reporter = new TesboReporter();
    const logs = await captureLogs(async () => {
      await reporter.onBegin(fakeConfig, emptySuite);
      await reporter.onEnd({ status: "passed" } as never);
    });
    assert.match(logs, /no test carries a/);
  });
});

test("an untagged suite is reported as untagged, not as a config problem", async () => {
  await withEnv({ [ENV_BASE_URL]: BASE, [ENV_PROJECT_ID]: PROJECT, [ENV_TOKEN]: TOKEN }, async () => {
    const reporter = new TesboReporter();
    const logs = await captureLogs(async () => {
      await reporter.onBegin(fakeConfig, emptySuite);
      await reporter.onEnd({ status: "passed" } as never);
    });
    assert.equal(logs.includes("not configured"), false);
  });
});

/*
 * strict mode is about the *suite* (untagged tests), requireConfig about the *environment*. Keeping
 * them separate matters: a fully-tagged suite with no credentials and a fully-credentialled run over
 * an untagged suite are different problems with different fixes.
 */
test("strict mode fails an untagged suite even when the config is complete", async () => {
  await withEnv({ [ENV_BASE_URL]: BASE, [ENV_PROJECT_ID]: PROJECT, [ENV_TOKEN]: TOKEN }, async () => {
    const suite = {
      allTests: () => [{ tags: [], annotations: [], titlePath: () => ["file.spec.ts", "a test"] }]
    } as unknown as Suite;
    const reporter = new TesboReporter({ strict: true });
    await assert.rejects(() => reporter.onBegin(fakeConfig, suite), /strict mode/);
  });
});
