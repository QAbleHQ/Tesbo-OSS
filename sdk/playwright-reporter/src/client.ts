/**
 * HTTP client for the Tesbo automation ingest.
 *
 * The one rule that shapes this whole file is Basecamp 10189985971 §7: **"if the Tesbo API is
 * unreachable mid-run, the SDK should log locally and not fail the customer's test suite (never let
 * a Tesbo outage break someone's CI pipeline)."**
 *
 * So every method here resolves rather than rejects. A failure is recorded, counted, and reported in
 * the end-of-run summary; it never propagates into the caller's `await`. The single exception is the
 * startup validation the caller performs deliberately in strict mode, which is a decision the
 * project has opted into.
 */

export interface TesboClientOptions {
  baseUrl: string;
  projectId: string;
  token: string;
  /** Per-request timeout. A hung Tesbo must not hold a CI job open. */
  timeoutMs?: number;
  /** Attempts per request, including the first. Retries are for transient failures only. */
  retries?: number;
  /** Where degradation notices go. Defaults to console.warn. */
  log?: (message: string) => void;
}

export interface CreateRunBody {
  name: string;
  externalId?: string;
  triggeredBy?: string;
  commitSha?: string;
  branch?: string;
  buildUrl?: string;
  environment?: string;
  buildVersion?: string;
  releaseName?: string;
  caseIds?: string[];
}

export interface ResultBody {
  caseId: string;
  status: "pass" | "fail" | "skip" | "blocked" | "timedOut" | "interrupted";
  durationMs?: number;
  retryCount?: number;
  errorMessage?: string;
  errorStack?: string;
}

/** What a call produced: `ok` with data, or a failure that has already been logged. */
export type CallResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number | null };

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 3;
/** Statuses worth retrying: transient server and gateway failures, plus rate limiting. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export class TesboClient {
  private readonly baseUrl: string;
  private readonly log: (message: string) => void;
  private readonly timeoutMs: number;
  private readonly retries: number;

  /** Counted so the end-of-run summary can say how much was lost, rather than implying success. */
  public failures = 0;

  constructor(private readonly options: TesboClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.log = options.log ?? ((message) => console.warn(message));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = Math.max(1, options.retries ?? DEFAULT_RETRIES);
  }

  private url(suffix: string): string {
    return `${this.baseUrl}/api/projects/${this.options.projectId}/automation${suffix}`;
  }

  /**
   * One request, with bounded retries and a timeout, that never throws.
   *
   * 4xx other than the retryable ones is not retried: a 400 for a bad status value or a 404 for an
   * unknown case id will fail identically every time, and retrying it three times only delays the
   * suite and triples the noise.
   */
  private async request<T>(
    method: string,
    suffix: string,
    body?: unknown,
    form?: FormData
  ): Promise<CallResult<T>> {
    let lastError = "unknown error";
    let lastStatus: number | null = null;

    for (let attempt = 1; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(this.url(suffix), {
          method,
          headers: {
            Authorization: `Bearer ${this.options.token}`,
            ...(form ? {} : { "Content-Type": "application/json" })
          },
          body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
          signal: controller.signal
        });

        if (res.ok) return { ok: true, data: (await res.json().catch(() => ({}))) as T };

        lastStatus = res.status;
        const text = await res.text().catch(() => "");
        lastError = this.readError(text) ?? `HTTP ${res.status}`;
        if (!RETRYABLE_STATUSES.has(res.status)) break;
      } catch (err) {
        lastError =
          err instanceof Error && err.name === "AbortError"
            ? `timed out after ${this.timeoutMs}ms`
            : err instanceof Error
              ? err.message
              : String(err);
      } finally {
        clearTimeout(timer);
      }

      if (attempt < this.retries) {
        // Exponential backoff with a jitter-free, bounded delay: predictable in logs, and short
        // enough that three attempts cannot add meaningful time to a test run.
        await new Promise((resolve) => setTimeout(resolve, Math.min(1_000 * 2 ** (attempt - 1), 4_000)));
      }
    }

    this.failures += 1;
    this.log(`[tesbo] ${method} ${suffix} failed: ${lastError}`);
    return { ok: false, error: lastError, status: lastStatus };
  }

  /** The backend answers errors as `{ error: "..." }`; fall back to the raw body. */
  private readError(text: string): string | null {
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string };
      return parsed.error ?? parsed.message ?? text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  }

  /** Card §3: validate the suite's case ids before a single test runs. */
  resolveCases(caseIds: string[]) {
    return this.request<{ requested: number; known: { caseId: string; title: string; status: string }[]; unknown: string[] }>(
      "POST",
      "/cases/resolve",
      { caseIds }
    );
  }

  createRun(body: CreateRunBody) {
    return this.request<{ runId: string; name: string; reused: boolean; unknownCaseIds: string[] }>(
      "POST",
      "/runs",
      body
    );
  }

  recordResult(runId: string, body: ResultBody) {
    return this.request<{ executionId: string; status: string; retryCount: number }>(
      "POST",
      `/runs/${runId}/results`,
      body
    );
  }

  closeRun(runId: string, status: "completed" | "incomplete", summary: Record<string, number>) {
    return this.request<{ runId: string; mismatch: Record<string, { reported: number; stored: number }> | null }>(
      "PATCH",
      `/runs/${runId}/close`,
      { status, summary }
    );
  }

  /**
   * Uploads evidence for one result.
   *
   * `skipped: "quota"` is a success, not a failure: the workspace's storage is full and the backend
   * deliberately drops the file rather than failing the result (card §5). The caller counts it so
   * the run summary can say so, but nothing here treats it as an error.
   */
  async uploadEvidence(
    runId: string,
    caseId: string,
    kind: "screenshot" | "video" | "trace" | "log",
    files: { name: string; body: Uint8Array; contentType: string }[]
  ): Promise<CallResult<{ total: number; skipped: "quota" | null }>> {
    const form = new FormData();
    form.append("kind", kind);
    for (const file of files) {
      form.append("files", new Blob([file.body as unknown as BlobPart], { type: file.contentType }), file.name);
    }
    return this.request<{ total: number; skipped: "quota" | null }>(
      "POST",
      `/runs/${runId}/results/${encodeURIComponent(caseId)}/evidence`,
      undefined,
      form
    );
  }
}
