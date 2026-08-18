import { Injectable } from "@nestjs/common";
import { AppConfigService } from "./app-config.service";

/**
 * What kind of Postmark server the configured token belongs to.
 *
 * A **Sandbox** server accepts every send over the API, records it in Activity, and delivers it to
 * nobody — so it cannot bounce, whatever address the send was addressed to. A **Live** server
 * delivers for real. "unknown" means Postmark couldn't be asked (network, or a rejected token) and
 * is deliberately never treated as safe.
 */
export type PostmarkServerKind = "sandbox" | "live" | "unknown" | "not_configured";

/**
 * OTP codes are handled differently from every other email: in log mode they are written to stdout
 * and posted nowhere at all, because stdout is the only channel a local developer or the e2e suite
 * can read a code back from.
 */
export type EmailKind = "otp" | "communication";

/** Where mail actually ends up on this stack — reported by /api/admin/system/health and at boot. */
export type EmailReach = "recipients" | "sandbox_only" | "log_only";

export type DeliveryDecision =
  | { post: true }
  | { post: false; reason: "no_token" | "log_mode_otp" | "not_a_sandbox_server" };

// Short on purpose: this runs in front of a send, and an unreachable Postmark must not hold an
// invite or a webhook handler open. A timeout resolves to "unknown", which blocks the send in log
// mode rather than risking a live delivery.
const PROBE_TIMEOUT_MS = 5_000;
const SERVER_ENDPOINT = "https://api.postmarkapp.com/server";

/**
 * The one place that decides whether an email may actually be handed to Postmark.
 *
 * Two modes, set by EMAIL_DELIVERY_MODE:
 *
 * - **live** — everything is posted to Postmark and really delivered. Production only.
 * - **log** (the default) — every email is written to the log. OTP codes stop there and are never
 *   posted anywhere. The remaining communication emails (invite, billing, storage) are still posted
 *   to Postmark, so the real API path, templates and error handling are genuinely exercised — but
 *   only after Postmark itself has confirmed the configured server is a **Sandbox** server, which
 *   delivers to nobody. A Live token in log mode sends nothing at all.
 *
 * Why the server type is verified rather than trusted: a Sandbox and a Live server token are
 * indistinguishable by shape, so "use the sandbox key locally" is otherwise only ever a convention.
 * The one time it was broken — a live token in a local .env while the e2e suite invented addresses
 * at a domain that did not exist — roughly 1100 bounces accumulated and the sending account was
 * flagged. This class makes that specific accident impossible: to deliver anything, the stack has
 * to either be pointed at a sandbox server or say EMAIL_DELIVERY_MODE=live out loud.
 */
@Injectable()
export class EmailDeliveryPolicy {
  // The in-flight probe rather than its result, so N concurrent sends share a single lookup
  // instead of each firing its own request at Postmark.
  private probe: Promise<PostmarkServerKind> | null = null;
  private readonly warnedAbout = new Set<PostmarkServerKind>();

  constructor(private readonly config: AppConfigService) {}

  get mode(): "live" | "log" {
    return this.config.emailDeliveryMode;
  }

  /** True when this email should also be written to the log (the only readable channel in log mode). */
  get logsEveryEmail(): boolean {
    return this.mode === "log";
  }

  /** Asks Postmark what kind of server the configured token belongs to. Cached; see serverKind(). */
  private async fetchServerKind(): Promise<PostmarkServerKind> {
    try {
      const response = await fetch(SERVER_ENDPOINT, {
        headers: {
          Accept: "application/json",
          "X-Postmark-Server-Token": this.config.postmarkApiToken
        },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      });
      if (!response.ok) return "unknown";
      const body = (await response.json()) as { DeliveryType?: unknown };
      const deliveryType = typeof body.DeliveryType === "string" ? body.DeliveryType.toLowerCase() : "";
      if (deliveryType === "sandbox") return "sandbox";
      if (deliveryType === "live") return "live";
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  async serverKind(): Promise<PostmarkServerKind> {
    if (!this.config.postmarkApiToken) return "not_configured";
    if (!this.probe) this.probe = this.fetchServerKind();
    const kind = await this.probe;
    // A failed probe is deliberately NOT cached: a momentary network blip must not pin the answer to
    // "unknown" — and so silently stop all mail — for the rest of the process's life. A successful
    // answer is cached forever, since a server's delivery type doesn't change under a running app.
    if (kind === "unknown") this.probe = null;
    return kind;
  }

  /** Whether this one email may be posted to Postmark. */
  async decide(kind: EmailKind): Promise<DeliveryDecision> {
    if (!this.config.postmarkApiToken) return { post: false, reason: "no_token" };
    if (this.mode === "live") return { post: true };
    if (kind === "otp") return { post: false, reason: "log_mode_otp" };

    const server = await this.serverKind();
    if (server === "sandbox") return { post: true };
    this.warnOnce(server);
    return { post: false, reason: "not_a_sandbox_server" };
  }

  /**
   * Once per server kind, not once per email: a downgrade sweep or an import can trigger hundreds of
   * sends, and the operator needs this to be readable, not to drown the log it appears in.
   */
  private warnOnce(server: PostmarkServerKind): void {
    if (this.warnedAbout.has(server)) return;
    this.warnedAbout.add(server);
    const what =
      server === "live"
        ? "a LIVE server, which would deliver for real"
        : "a server whose delivery type could not be read";
    console.error(
      `[email] Blocking delivery: EMAIL_DELIVERY_MODE=log requires a Postmark SANDBOX server, but the ` +
        `configured POSTMARK_API_TOKEN belongs to ${what}. Emails are being written to the log instead. ` +
        `Point POSTMARK_API_TOKEN at a Sandbox server for local and CI stacks, or set ` +
        `EMAIL_DELIVERY_MODE=live if real delivery is intended.`
    );
  }

  /**
   * How far mail gets on this stack. Honest about the awkward combinations: a live mode with a
   * sandbox token delivers to nobody, and a live mode whose probe failed has to be reported as
   * reaching recipients, because the send does go out and nothing here can prove otherwise.
   */
  async describe(): Promise<{ mode: "live" | "log"; server: PostmarkServerKind; reach: EmailReach }> {
    const server = await this.serverKind();
    const reach: EmailReach =
      server === "not_configured"
        ? "log_only"
        : this.mode === "live"
          ? server === "sandbox"
            ? "sandbox_only"
            : "recipients"
          : server === "sandbox"
            ? "sandbox_only"
            : "log_only";
    return { mode: this.mode, server, reach };
  }
}
