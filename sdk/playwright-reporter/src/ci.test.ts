import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { detectRunSource } from "./ci";

/*
 * detectRunSource reads process.env directly, so each test clears every variable any detector looks
 * at. Leaving one set would make the next assertion depend on test order — and on whether the suite
 * itself happens to be running in CI, which is exactly where this file will run.
 */
const MANAGED = [
  "CI",
  "GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_REF_NAME", "GITHUB_HEAD_REF",
  "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_RUN_NUMBER", "GITHUB_WORKFLOW", "GITHUB_SERVER_URL",
  "GITLAB_CI", "CI_COMMIT_SHA", "CI_COMMIT_REF_NAME", "CI_PIPELINE_ID", "CI_PIPELINE_IID",
  "CI_PIPELINE_URL", "CI_JOB_URL", "CI_PROJECT_NAME",
  "JENKINS_URL", "BUILD_NUMBER", "BUILD_URL", "JOB_NAME", "GIT_COMMIT", "GIT_BRANCH", "BRANCH_NAME",
  "CIRCLECI", "CIRCLE_SHA1", "CIRCLE_BRANCH", "CIRCLE_BUILD_URL", "CIRCLE_BUILD_NUM",
  "CIRCLE_WORKFLOW_ID", "CIRCLE_PROJECT_REPONAME",
  "TF_BUILD", "BUILD_BUILDID", "BUILD_SOURCEVERSION", "BUILD_SOURCEBRANCHNAME",
  "SYSTEM_TEAMFOUNDATIONCOLLECTIONURI", "SYSTEM_TEAMPROJECT", "BUILD_DEFINITIONNAME", "BUILD_BUILDNUMBER",
  "BITBUCKET_BUILD_NUMBER", "BITBUCKET_COMMIT", "BITBUCKET_BRANCH", "BITBUCKET_REPO_FULL_NAME",
  "BITBUCKET_REPO_SLUG",
  "COMMIT_SHA"
];

const saved = new Map<string, string | undefined>();
for (const name of MANAGED) saved.set(name, process.env[name]);

function only(vars: Record<string, string>) {
  for (const name of MANAGED) delete process.env[name];
  Object.assign(process.env, vars);
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("a developer's laptop is a local run with no provenance", () => {
  only({});
  const source = detectRunSource();
  assert.equal(source.triggeredBy, "local");
  assert.equal(source.externalId, undefined);
});

/*
 * An unrecognised CI system must not be labelled 'local' — that would file CI results in with
 * someone's laptop runs, and "which of these came from CI" is the first question asked of a flaky
 * result.
 */
test("bare CI=true is 'other', never 'local'", () => {
  only({ CI: "true" });
  assert.equal(detectRunSource().triggeredBy, "other");
});

test("GitHub Actions provenance, with a build URL assembled from the run id", () => {
  only({
    CI: "true",
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "acme/web",
    GITHUB_SHA: "abc123def456",
    GITHUB_REF_NAME: "main",
    GITHUB_RUN_ID: "77",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_NUMBER: "12",
    GITHUB_WORKFLOW: "E2E"
  });
  const source = detectRunSource();
  assert.equal(source.triggeredBy, "github-actions");
  assert.equal(source.commitSha, "abc123def456");
  assert.equal(source.branch, "main");
  assert.equal(source.buildUrl, "https://github.com/acme/web/actions/runs/77");
  assert.equal(source.suggestedName, "E2E #12");
  assert.equal(source.externalId, "gha-77-1");
});

/*
 * On a pull_request event GITHUB_REF_NAME is the synthetic '<n>/merge' ref, which is never the
 * branch a reader means. GITHUB_HEAD_REF is the source branch, so it has to win.
 */
test("on a pull request the source branch wins over the merge ref", () => {
  only({
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "acme/web",
    GITHUB_REF_NAME: "42/merge",
    GITHUB_HEAD_REF: "feature/login",
    GITHUB_RUN_ID: "9"
  });
  assert.equal(detectRunSource().branch, "feature/login");
});

/*
 * A workflow re-run is a new execution of the same tests and must get its own run: squashing
 * attempt 2 into attempt 1 would overwrite the record of what failed the first time, which is
 * precisely what someone re-running a flaky job wants to compare against.
 */
test("a re-run gets a distinct idempotency key, so it does not overwrite the first attempt", () => {
  only({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/web", GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "2" });
  assert.equal(detectRunSource().externalId, "gha-77-2");
});

test("shards within one attempt share the key, so they converge on one run", () => {
  only({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/web", GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "3" });
  const first = detectRunSource().externalId;
  const second = detectRunSource().externalId;
  assert.equal(first, second);
});

test("GitHub Enterprise's server URL is respected", () => {
  only({
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "acme/web",
    GITHUB_RUN_ID: "5",
    GITHUB_SERVER_URL: "https://github.acme.internal"
  });
  assert.equal(detectRunSource().buildUrl, "https://github.acme.internal/acme/web/actions/runs/5");
});

test("GitLab CI provenance", () => {
  only({
    GITLAB_CI: "true",
    CI_COMMIT_SHA: "deadbeef",
    CI_COMMIT_REF_NAME: "develop",
    CI_PIPELINE_ID: "900",
    CI_PIPELINE_IID: "12",
    CI_PIPELINE_URL: "https://gitlab.com/acme/web/-/pipelines/900",
    CI_PROJECT_NAME: "web"
  });
  const source = detectRunSource();
  assert.equal(source.triggeredBy, "gitlab-ci");
  assert.equal(source.externalId, "gitlab-900");
  assert.equal(source.suggestedName, "web pipeline #12");
});

/*
 * BUILD_NUMBER restarts at 1 for every Jenkins job, so it alone is not unique across a Tesbo
 * project that several jobs report into — the job name has to be part of the key.
 */
test("Jenkins keys on job name as well as build number", () => {
  only({ JENKINS_URL: "https://ci.acme.io/", BUILD_NUMBER: "4", JOB_NAME: "web-e2e", GIT_COMMIT: "cafe" });
  const source = detectRunSource();
  assert.equal(source.triggeredBy, "jenkins");
  assert.equal(source.externalId, "jenkins-web-e2e-4");
});

test("CircleCI keys on the workflow id, which is shared across its parallel containers", () => {
  only({ CIRCLECI: "true", CIRCLE_WORKFLOW_ID: "wf-1", CIRCLE_BUILD_NUM: "8", CIRCLE_PROJECT_REPONAME: "web" });
  assert.equal(detectRunSource().externalId, "circle-wf-1");
});

test("Azure Pipelines assembles its build URL from the collection and project", () => {
  only({
    TF_BUILD: "True",
    BUILD_BUILDID: "31",
    SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: "https://dev.azure.com/acme/",
    SYSTEM_TEAMPROJECT: "Web"
  });
  const source = detectRunSource();
  assert.equal(source.triggeredBy, "azure-pipelines");
  assert.equal(source.buildUrl, "https://dev.azure.com/acme/Web/_build/results?buildId=31");
});

test("Bitbucket Pipelines provenance", () => {
  only({ BITBUCKET_BUILD_NUMBER: "17", BITBUCKET_REPO_FULL_NAME: "acme/web", BITBUCKET_COMMIT: "f00d" });
  const source = detectRunSource();
  assert.equal(source.triggeredBy, "bitbucket-pipelines");
  assert.equal(source.buildUrl, "https://bitbucket.org/acme/web/pipelines/results/17");
});

/*
 * GITHUB_ACTIONS is exported inside a GitHub-hosted job even when the suite is driven by something
 * else, so the most specific detector has to win over the generic CI flag.
 */
test("a specific provider wins over the generic CI flag", () => {
  only({ CI: "true", GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/web", GITHUB_RUN_ID: "1" });
  assert.equal(detectRunSource().triggeredBy, "github-actions");
});

test("whitespace-only variables are treated as absent", () => {
  only({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/web", GITHUB_RUN_ID: "1", GITHUB_SHA: "   " });
  assert.equal(detectRunSource().commitSha, undefined);
});
