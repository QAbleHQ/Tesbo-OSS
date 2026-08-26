import { Logger } from "@nestjs/common";

/*
 * Langfuse bootstrap.
 *
 * Module-level rather than a Nest provider on purpose. OpenTelemetry's model is ambient: spans
 * attach to the active context, not to an injected object. Threading a service through
 * LegacyService's constructor would buy nothing and would touch a 12,000-line file that other
 * work is actively editing.
 *
 * Three rules this file exists to enforce:
 *   1. Tracing must never break Zyra. Every entry point is wrapped; a failure here logs and
 *      returns, it does not throw into a chat turn.
 *   2. It must fail CLOSED on the endpoint. The SDK silently defaults baseUrl to
 *      cloud.langfuse.com, so a container that failed to load .env would ship customer prompts,
 *      knowledge-base documents and Jira ticket bodies to a third party. That is a data-egress
 *      incident caused by a missing environment variable, so an unset or cloud URL disables
 *      tracing entirely unless LANGFUSE_ALLOW_CLOUD is explicitly set.
 *   3. Nothing starts without keys. No keys, no SDK, no network, no cost.
 */

const logger = new Logger("Langfuse");

let started = false;
let sdk: { shutdown: () => Promise<void> } | null = null;
let processor: { forceFlush: () => Promise<void> } | null = null;

export function isTracingEnabled(): boolean {
  return started;
}

function resolveConfig(): { publicKey: string; secretKey: string; baseUrl: string; environment: string } | null {
  const publicKey = String(process.env.LANGFUSE_PUBLIC_KEY || "").trim();
  const secretKey = String(process.env.LANGFUSE_SECRET_KEY || "").trim();
  const baseUrl = String(process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_BASEURL || "").trim();
  const environment = String(process.env.LANGFUSE_ENVIRONMENT || "development").trim();

  if (String(process.env.LANGFUSE_ENABLED || "").toLowerCase() === "false") {
    logger.log("Tracing disabled by LANGFUSE_ENABLED=false.");
    return null;
  }
  if (!publicKey || !secretKey) {
    logger.log("Tracing off: no LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY configured.");
    return null;
  }
  if (!baseUrl) {
    logger.warn("Tracing off: LANGFUSE_BASE_URL is unset. Refusing to fall back to Langfuse Cloud — prompts carry customer data.");
    return null;
  }
  const allowCloud = String(process.env.LANGFUSE_ALLOW_CLOUD || "").toLowerCase() === "true";
  if (/cloud\.langfuse\.com/i.test(baseUrl) && !allowCloud) {
    logger.warn("Tracing off: LANGFUSE_BASE_URL points at Langfuse Cloud. Set LANGFUSE_ALLOW_CLOUD=true to send customer data there deliberately.");
    return null;
  }
  return { publicKey, secretKey, baseUrl, environment };
}

/**
 * Strips anything key-shaped from span input/output before export.
 *
 * NOTE this is a second line of defence, not the first. The Langfuse span processor applies this
 * hook to `input` and `output` ONLY — observation metadata, model names, tags, and every
 * propagated trace attribute bypass it entirely (measured, not assumed). The real protection is
 * that ai-trace.ts never receives a key-bearing object in the first place: it takes named scalars,
 * never a `key`/`params` blob to pick fields out of.
 */
function mask({ data }: { data: unknown }): unknown {
  const scrub = (value: string): string =>
    value
      .replace(/sk-ant-[A-Za-z0-9_\-]{8,}/g, "[REDACTED_KEY]")
      .replace(/sk-[A-Za-z0-9_\-]{8,}/g, "[REDACTED_KEY]")
      .replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/gi, "Bearer [REDACTED]");
  try {
    if (typeof data === "string") return scrub(data);
    return JSON.parse(scrub(JSON.stringify(data)));
  } catch {
    return data;
  }
}

/** Starts the OTel pipeline. Safe to call more than once; only the first call does anything. */
export async function startLangfuse(): Promise<void> {
  if (started) return;
  const config = resolveConfig();
  if (!config) return;

  try {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { LangfuseSpanProcessor } = await import("@langfuse/otel");

    const spanProcessor = new LangfuseSpanProcessor({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
      environment: config.environment,
      mask
    });

    // NodeSDK auto-configures OTLP exporters aimed at localhost:4318 when these are unset. With
    // nothing listening there it raises an unhandled "Request timed out" that takes the process
    // down — an observability dependency killing the API is exactly backwards.
    process.env.OTEL_TRACES_EXPORTER ||= "none";
    process.env.OTEL_METRICS_EXPORTER ||= "none";
    process.env.OTEL_LOGS_EXPORTER ||= "none";

    const instance = new NodeSDK({ spanProcessors: [spanProcessor] });
    instance.start();

    sdk = instance as unknown as { shutdown: () => Promise<void> };
    processor = spanProcessor as unknown as { forceFlush: () => Promise<void> };
    started = true;
    logger.log(`Tracing on → ${config.baseUrl} (environment: ${config.environment}).`);
  } catch (err) {
    logger.warn(`Tracing failed to start, continuing without it: ${err instanceof Error ? err.message : err}`);
    started = false;
  }
}

/**
 * Flushes buffered spans. Must run on shutdown: spans batch in memory, so without this every
 * container restart drops the last few seconds of traces — and a restart is precisely when the
 * interesting trace exists.
 */
export async function flushLangfuse(): Promise<void> {
  if (!started || !processor) return;
  try {
    await processor.forceFlush();
  } catch (err) {
    logger.warn(`Langfuse flush failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function stopLangfuse(): Promise<void> {
  if (!started) return;
  await flushLangfuse();
  try {
    await sdk?.shutdown();
  } catch (err) {
    logger.warn(`Langfuse shutdown failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    started = false;
    sdk = null;
    processor = null;
  }
}
