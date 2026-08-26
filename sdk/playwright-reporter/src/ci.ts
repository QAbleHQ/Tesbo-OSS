/**
 * CI provenance, read from the environment.
 *
 * Basecamp 10189985971 §4: "the SDK should auto-capture at run creation, when available: git commit
 * SHA, branch name, CI build URL, and triggered_by. This costs nothing extra — the SDK already has
 * access to this context via env vars — but is what lets a QA lead trace a failure back to the exact
 * commit/branch without leaving Tesbo."
 *
 * Everything here is best-effort and every field is optional: a developer running the suite on their
 * laptop has none of it, which is `triggeredBy: "local"` and nothing else.
 */

export interface RunSource {
  triggeredBy: string;
  commitSha?: string;
  branch?: string;
  buildUrl?: string;
  /** A default run name when the caller does not supply one. */
  suggestedName: string;
  /**
   * Stable per CI run, used as the ingest's idempotency key so a re-run of the same workflow
   * updates its existing Tesbo run instead of opening a second one holding half the results.
   * Undefined locally, where every invocation genuinely is a new run.
   */
  externalId?: string;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

/**
 * GitHub Actions.
 *
 * GITHUB_HEAD_REF is set only on pull_request events and holds the *source* branch, which is what a
 * reader means by "which branch" — GITHUB_REF_NAME on a PR is the synthetic `<n>/merge` ref, which
 * is never the answer anyone wants.
 */
function github(): RunSource | null {
  const repo = env("GITHUB_REPOSITORY");
  if (!env("GITHUB_ACTIONS") || !repo) return null;
  const runId = env("GITHUB_RUN_ID");
  const attempt = env("GITHUB_RUN_ATTEMPT");
  return {
    triggeredBy: "github-actions",
    commitSha: env("GITHUB_SHA"),
    branch: env("GITHUB_HEAD_REF") ?? env("GITHUB_REF_NAME"),
    buildUrl: runId ? `${env("GITHUB_SERVER_URL") ?? "https://github.com"}/${repo}/actions/runs/${runId}` : undefined,
    suggestedName: `${env("GITHUB_WORKFLOW") ?? "CI"} #${env("GITHUB_RUN_NUMBER") ?? runId ?? "?"}`,
    /*
     * The attempt is part of the key on purpose. A *re-run* of a workflow is a new execution of the
     * same tests and deserves its own run — squashing attempt 2 into attempt 1's run would
     * overwrite the record of what failed the first time, which is exactly what someone re-running
     * a flaky job wants to compare against. The key exists to deduplicate the *shards within one
     * attempt*, which all share it.
     */
    externalId: runId ? `gha-${runId}-${attempt ?? "1"}` : undefined
  };
}

function gitlab(): RunSource | null {
  if (!env("GITLAB_CI")) return null;
  const pipelineId = env("CI_PIPELINE_ID");
  return {
    triggeredBy: "gitlab-ci",
    commitSha: env("CI_COMMIT_SHA"),
    branch: env("CI_COMMIT_REF_NAME"),
    buildUrl: env("CI_PIPELINE_URL") ?? env("CI_JOB_URL"),
    suggestedName: `${env("CI_PROJECT_NAME") ?? "CI"} pipeline #${env("CI_PIPELINE_IID") ?? pipelineId ?? "?"}`,
    externalId: pipelineId ? `gitlab-${pipelineId}` : undefined
  };
}

function jenkins(): RunSource | null {
  const buildNumber = env("BUILD_NUMBER");
  if (!env("JENKINS_URL") || !buildNumber) return null;
  return {
    triggeredBy: "jenkins",
    commitSha: env("GIT_COMMIT"),
    branch: env("BRANCH_NAME") ?? env("GIT_BRANCH"),
    buildUrl: env("BUILD_URL"),
    suggestedName: `${env("JOB_NAME") ?? "Jenkins"} #${buildNumber}`,
    // JOB_NAME is included because BUILD_NUMBER restarts per job, so it alone is not unique
    // across a Tesbo project that several jobs report into.
    externalId: `jenkins-${env("JOB_NAME") ?? "job"}-${buildNumber}`
  };
}

function circle(): RunSource | null {
  if (!env("CIRCLECI")) return null;
  const workflowId = env("CIRCLE_WORKFLOW_ID");
  return {
    triggeredBy: "circleci",
    commitSha: env("CIRCLE_SHA1"),
    branch: env("CIRCLE_BRANCH"),
    buildUrl: env("CIRCLE_BUILD_URL"),
    suggestedName: `${env("CIRCLE_PROJECT_REPONAME") ?? "CircleCI"} #${env("CIRCLE_BUILD_NUM") ?? "?"}`,
    externalId: workflowId ? `circle-${workflowId}` : undefined
  };
}

function azure(): RunSource | null {
  const buildId = env("BUILD_BUILDID");
  if (!env("TF_BUILD") || !buildId) return null;
  const collection = env("SYSTEM_TEAMFOUNDATIONCOLLECTIONURI");
  const project = env("SYSTEM_TEAMPROJECT");
  return {
    triggeredBy: "azure-pipelines",
    commitSha: env("BUILD_SOURCEVERSION"),
    branch: env("BUILD_SOURCEBRANCHNAME"),
    buildUrl: collection && project ? `${collection}${project}/_build/results?buildId=${buildId}` : undefined,
    suggestedName: `${env("BUILD_DEFINITIONNAME") ?? "Azure Pipelines"} #${env("BUILD_BUILDNUMBER") ?? buildId}`,
    externalId: `azure-${buildId}`
  };
}

function bitbucket(): RunSource | null {
  const buildNumber = env("BITBUCKET_BUILD_NUMBER");
  if (!buildNumber) return null;
  const repo = env("BITBUCKET_REPO_FULL_NAME");
  return {
    triggeredBy: "bitbucket-pipelines",
    commitSha: env("BITBUCKET_COMMIT"),
    branch: env("BITBUCKET_BRANCH"),
    buildUrl: repo ? `https://bitbucket.org/${repo}/pipelines/results/${buildNumber}` : undefined,
    suggestedName: `${env("BITBUCKET_REPO_SLUG") ?? "Bitbucket"} #${buildNumber}`,
    externalId: `bitbucket-${repo ?? "repo"}-${buildNumber}`
  };
}

/**
 * Detects the CI provider, or reports a local run.
 *
 * Ordered most-specific first. `CI=true` alone is reported as "other" rather than "local", because
 * an unrecognised CI system is still not somebody's laptop and mislabelling it would put CI results
 * in with local ones.
 */
export function detectRunSource(): RunSource {
  for (const detect of [github, gitlab, jenkins, circle, azure, bitbucket]) {
    const source = detect();
    if (source) return source;
  }
  const isCi = Boolean(env("CI"));
  return {
    triggeredBy: isCi ? "other" : "local",
    commitSha: env("GIT_COMMIT") ?? env("COMMIT_SHA"),
    branch: env("GIT_BRANCH") ?? env("BRANCH_NAME"),
    suggestedName: isCi ? "CI run" : "Local run"
  };
}
