"use client";

import { IconAlertTriangle, IconGitBranch, IconRepeat, IconRobot, IconClock, IconExternalLink } from "@tabler/icons-react";
import type { ExecutionItem, TestRunDetail, TestRunListItem } from "@/lib/api";

/*
 * Provenance and failure detail for results and runs that came from an automation SDK
 * (Basecamp 10189985971).
 *
 * Every field these render is null on a manual run or a human-recorded result, so both components
 * return null rather than an empty shell — a manually executed run should look exactly as it did
 * before this feature existed.
 */

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Short commit display, the length every git UI settled on. */
function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

/**
 * The one-line "how this run was produced" strip: trigger, branch, commit, and a link out to the
 * CI build. Card §4: this is what lets a QA lead trace a failure back to the exact commit without
 * leaving Tesbo.
 */
export function AutomationRunProvenance({ run }: { run: TestRunDetail | TestRunListItem }) {
  if (run.source !== "automation") return null;
  const incomplete = run.closeStatus === "incomplete";

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px]">
      <span
        className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium"
        style={{ borderColor: "var(--border)", color: "var(--muted)" }}
        title="Results in this run were reported by an automation SDK, not entered by hand"
      >
        <IconRobot size={13} />
        Automated
        {run.triggeredBy && <span className="text-[var(--muted-soft)]">· {run.triggeredBy}</span>}
      </span>

      {run.branchName && (
        <span className="inline-flex items-center gap-1.5 text-[var(--muted)]">
          <IconGitBranch size={13} />
          <span className="font-mono">{run.branchName}</span>
        </span>
      )}

      {run.commitSha && (
        <span className="font-mono text-[var(--muted)]" title={run.commitSha}>
          {shortSha(run.commitSha)}
        </span>
      )}

      {run.buildUrl && (
        <a
          href={run.buildUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium hover:underline"
          style={{ color: "var(--accent-light)" }}
        >
          Build <IconExternalLink size={12} />
        </a>
      )}

      {/*
       * An incomplete close means the SDK never called close — the process died, or CI killed the
       * job. The run still reads "Completed" (its status vocabulary is only Planning / In Progress /
       * Completed, and adding a fourth value would drop these out of every existing filter), so
       * this badge is the only place the difference is visible.
       */}
      {incomplete && (
        <span
          className="inline-flex items-center gap-1.5 font-medium"
          style={{ color: "var(--warning)" }}
          title="The test process never reported that it finished, so this run was closed for it. Some results may be missing."
        >
          <IconAlertTriangle size={13} />
          Incomplete
        </span>
      )}
    </div>
  );
}

/**
 * Per-result automation facts: how long the test took, how many attempts it needed, and the
 * framework's own failure message.
 *
 * `errorMessage` is shown separately from Actual Result on purpose — that field is the tester's own
 * prose and the ingest never writes it, so showing them in one box would blur who said what.
 */
export function AutomationResultMeta({ execution }: { execution: ExecutionItem }) {
  const isAutomated = execution.reportedBy === "automation";
  const hasDuration = execution.durationMs != null;
  const hasRetries = (execution.retryCount ?? 0) > 0;
  if (!isAutomated && !hasDuration && !hasRetries && !execution.errorMessage) return null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-[var(--muted)]">
        {isAutomated && (
          <span className="inline-flex items-center gap-1.5" title="Reported by an automation SDK">
            <IconRobot size={13} />
            Automated
          </span>
        )}
        {hasDuration && (
          <span className="inline-flex items-center gap-1.5">
            <IconClock size={13} />
            {formatDuration(execution.durationMs as number)}
          </span>
        )}
        {hasRetries && (
          <span
            className="inline-flex items-center gap-1.5"
            style={{ color: "var(--warning)" }}
            title="Attempts before the recorded one — a result that needed retries is a flakiness signal even when it passed"
          >
            <IconRepeat size={13} />
            {execution.retryCount} {execution.retryCount === 1 ? "retry" : "retries"}
          </span>
        )}
      </div>

      {execution.errorMessage && (
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--muted)]">
            Failure reported by automation
          </p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-2.5 font-mono text-[11.5px] leading-relaxed text-[var(--foreground)]">
            {execution.errorMessage}
          </pre>
        </div>
      )}
    </div>
  );
}
