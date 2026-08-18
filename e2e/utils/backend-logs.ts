import { execSync } from "node:child_process";
import { env } from "./env";

/*
 * Reading the backend container's stdout.
 *
 * With EMAIL_DELIVERY_MODE=log — the default, and what every local and CI stack runs — the backend
 * prints OTP codes and invite links instead of emailing them, so the log IS the mailbox for these
 * tests. That's deliberate: nothing this suite does can then bounce mail off the addresses it
 * invents, which is what once got the Postmark sending account flagged.
 *
 * Every function here is best-effort and returns null rather than throwing when `docker compose` is
 * unavailable — against a remote target there is no container to read, and the callers skip.
 */

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The last `tailLines` lines of the backend container's log ("all" for the whole thing), or null if
 * docker can't be reached.
 *
 * maxBuffer is raised because the default 1MB is easily exceeded by a busy container's log, and
 * execSync treats an overflow as a failure — which would look here like "docker is unavailable".
 */
export function readBackendLogs(tailLines: number | "all" = 500): string | null {
  try {
    return execSync(
      `docker compose -f "${env.dockerComposeFile}" logs ${env.dockerService} --no-color --tail=${tailLines}`,
      { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 },
    );
  } catch {
    return null;
  }
}

export function backendLogsAvailable(): boolean {
  return readBackendLogs(1) !== null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls the log until `pattern` matches, returning the match (capture groups included) or null.
 *
 * Polls rather than reads once because the API call that triggers the line returns before the line
 * is necessarily flushed. Stops immediately — without burning the timeout — when docker itself is
 * unavailable, since that will not start working mid-run.
 */
export async function waitForBackendLog(
  pattern: RegExp,
  { timeoutMs = 8_000, tailLines = 500, intervalMs = 500 } = {},
): Promise<RegExpMatchArray | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const logs = readBackendLogs(tailLines);
    if (logs === null) return null;
    const match = logs.match(pattern);
    if (match) return match;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

/** The six-digit code the backend printed for `email`, or null if it never appeared. */
export async function waitForOtpInLogs(email: string, timeoutMs = 8_000): Promise<string | null> {
  // Format is fixed by EmailService.sendOtp — "OTP for <email>: <code>".
  const match = await waitForBackendLog(new RegExp(`OTP for ${escapeRegExp(email)}: (\\d{6})`), { timeoutMs });
  return match?.[1] ?? null;
}

/** The accept URL the backend printed for an invite to `email`, or null. */
export async function waitForInviteLinkInLogs(email: string, timeoutMs = 8_000): Promise<string | null> {
  // Format is fixed by EmailService.sendInvite — "[INVITE] <email> → <url>".
  const match = await waitForBackendLog(new RegExp(`\\[INVITE\\] ${escapeRegExp(email)} → (\\S+)`), { timeoutMs });
  return match?.[1] ?? null;
}

export interface EmailDeliveryReport {
  mode: "live" | "log";
  server: string;
  reach: "recipients" | "sandbox_only" | "log_only";
}

/**
 * What the backend announced about email delivery when it booted.
 *
 * Read from the boot line rather than from the admin health endpoint so it needs no platform-admin
 * session: `[email] delivery mode=log postmark_server=sandbox reach=sandbox_only`.
 *
 * Uses a large tail because this line is printed once, at startup, and by the time a suite runs
 * there may be a lot of request logging after it.
 */
export function readEmailDeliveryReport(): EmailDeliveryReport | null {
  // A long-running container can push the boot line well past any fixed tail, and "not found"
  // would then read as "this stack didn't report", so fall back to the whole log before giving up.
  return reportFrom(readBackendLogs(20_000)) ?? reportFrom(readBackendLogs("all"));
}

function reportFrom(logs: string | null): EmailDeliveryReport | null {
  if (logs === null) return null;
  // Last occurrence wins: a restarted container prints the line again, and only the newest is true.
  const last = [...logs.matchAll(/\[email\] delivery mode=(\S+) postmark_server=(\S+) reach=(\S+)/g)].at(-1);
  if (!last) return null;
  return {
    mode: last[1] as EmailDeliveryReport["mode"],
    server: last[2],
    reach: last[3] as EmailDeliveryReport["reach"],
  };
}
