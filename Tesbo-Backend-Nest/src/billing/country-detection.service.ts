import { Injectable } from "@nestjs/common";
import type { Request } from "express";
import { AppConfigService } from "../config/app-config.service";

/**
 * Resolves the visitor's country, used to decide who may be quoted and charged in INR.
 *
 * Ordering matters, because this gates a materially cheaper price list and a self-declared claim
 * can't be trusted:
 *
 *   1. BILLING_FORCE_COUNTRY — explicit operator override, for local dev and staging where every
 *      request arrives from a private IP that can't be geolocated at all.
 *   2. A CDN/edge country header (Cloudflare's cf-ipcountry and friends). Only consulted when
 *      TRUST_PROXY_COUNTRY_HEADER=true, because these headers are trivially forged by a client
 *      unless an edge that overwrites them sits in front of the app. This is the most reliable
 *      signal in production — the edge resolved it, not us.
 *   3. An IP geolocation lookup, cached.
 *   4. The workspace's DECLARED country, chosen at onboarding. Deliberately last and deliberately
 *      soft: it's self-reported, so it must never override a hard signal that disagrees with it.
 *      It exists only to stop a genuine Indian customer being silently quoted USD when detection
 *      yields nothing — a private IP, or an ip-api outage. The residual risk is someone declaring
 *      IN whose IP also happens to be unresolvable; `source` is returned and the detected country
 *      recorded so those cases are auditable rather than invisible.
 *
 * With no signal at all this fails CLOSED: unknown is not India, so the INR list stays unavailable.
 * That's the safe direction — a misdetected Indian buyer sees USD and can still be helped by
 * support, whereas a misdetected non-Indian buyer would silently get the cheaper list.
 */

/** Which signal decided the country. Surfaced so support can answer "why am I seeing USD?". */
export type CountrySource = "override" | "edge-header" | "ip" | "declared" | "unknown";

export interface CountryResolution {
  /** The country to act on, or null when nothing could determine it. */
  country: string | null;
  source: CountrySource;
  /**
   * What the request itself said (edge header or IP), independent of any declared value — recorded
   * by callers so a declared/detected disagreement can be reviewed later.
   */
  detected: string | null;
}

// Headers set by the major edges, in the order we trust them. All are two-letter ISO codes.
const EDGE_COUNTRY_HEADERS = [
  "cf-ipcountry", // Cloudflare
  "x-vercel-ip-country", // Vercel
  "x-appengine-country", // Google App Engine
  "fastly-client-country", // Fastly
  "cloudfront-viewer-country" // AWS CloudFront
];

// ip-api.com's free tier allows ~45 requests/minute per source IP. Without caching, a modest
// traffic spike would exhaust that quota and — because lookups fail closed — silently show USD
// to every Indian visitor for the rest of the minute. The cache is what makes this reliable.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/*
 * Failures are cached far more briefly than successes, and this asymmetry matters a lot.
 *
 * A country genuinely doesn't change, so a successful lookup is worth holding for hours. A FAILURE
 * is almost always transient — a burst that tripped the per-minute quota, or a blip reaching the
 * provider. Caching those for hours would convert a few seconds of upstream trouble into hours of
 * wrong pricing: with no hard signal, the decision silently degrades to the soft declared-country
 * fallback, which is exactly what the eligibility gate exists to avoid leaning on.
 *
 * Short enough to self-heal within a minute; long enough that a sustained outage doesn't turn every
 * page load into an upstream request.
 */
const NEGATIVE_CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 10_000;
const LOOKUP_TIMEOUT_MS = 2500;

type CacheEntry = { country: string | null; expiresAt: number };

@Injectable()
export class CountryDetectionService {
  private readonly cache = new Map<string, CacheEntry>();
  // Collapses concurrent lookups for the same IP into one upstream request, so a burst of
  // page loads from one visitor doesn't spend several of our rate-limited calls.
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(private readonly config: AppConfigService) {}

  /**
   * Resolves the country for a request. `declaredCountry` is the workspace's self-reported value and
   * is used only as a last resort — see the precedence note above.
   */
  async resolve(
    req: Pick<Request, "ip" | "headers"> | undefined,
    declaredCountry?: string | null
  ): Promise<CountryResolution> {
    const forced = this.normalizeCountry(this.config.billingForceCountry);
    if (forced) return { country: forced, source: "override", detected: null };

    if (this.config.trustProxyCountryHeader && req?.headers) {
      for (const name of EDGE_COUNTRY_HEADERS) {
        const raw = req.headers[name];
        const value = Array.isArray(raw) ? raw[0] : raw;
        const country = this.normalizeCountry(value);
        // Cloudflare sends "XX" for clients it can't place, and "T1" for Tor exits; both
        // normalize away below, so fall through to the IP lookup rather than trusting them.
        if (country) return { country, source: "edge-header", detected: country };
      }
    }

    const byIp = await this.lookupByIp(req?.ip);
    if (byIp) return { country: byIp, source: "ip", detected: byIp };

    // Nothing hard available. Fall back to the declared value, which is why it's called soft.
    const declared = this.normalizeCountry(declaredCountry);
    if (declared) return { country: declared, source: "declared", detected: null };

    return { country: null, source: "unknown", detected: null };
  }

  /** ISO 3166-1 alpha-2, uppercase, or null when it genuinely can't be determined. */
  async detect(req: Pick<Request, "ip" | "headers"> | undefined, declaredCountry?: string | null): Promise<string | null> {
    return (await this.resolve(req, declaredCountry)).country;
  }

  async isIndia(req: Pick<Request, "ip" | "headers"> | undefined, declaredCountry?: string | null): Promise<boolean> {
    return (await this.detect(req, declaredCountry)) === "IN";
  }

  private normalizeCountry(value: string | undefined | null): string | null {
    const code = (value ?? "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return null;
    // Cloudflare's placeholders for "unknown" and "Tor" aren't real countries.
    if (code === "XX" || code === "T1") return null;
    return code;
  }

  private async lookupByIp(ip: string | undefined): Promise<string | null> {
    if (!ip) return null;
    const normalized = ip.replace(/^::ffff:/, "");
    if (this.isPrivateIp(normalized)) return null;

    const cached = this.cache.get(normalized);
    if (cached && cached.expiresAt > Date.now()) return cached.country;

    const existing = this.inFlight.get(normalized);
    if (existing) return existing;

    const pending = this.fetchCountry(normalized)
      .then((country) => {
        this.remember(normalized, country);
        return country;
      })
      .finally(() => {
        this.inFlight.delete(normalized);
      });
    this.inFlight.set(normalized, pending);
    return pending;
  }

  private remember(ip: string, country: string | null): void {
    // Crude cap rather than a real LRU: this only exists to bound memory, and evicting the
    // oldest inserted key is good enough for a cache whose entries all expire anyway.
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    const ttl = country ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
    this.cache.set(ip, { country, expiresAt: Date.now() + ttl });
  }

  /**
   * ip-api.com, not ipapi.co: ipapi.co puts unauthenticated server-side requests behind a
   * Cloudflare JS challenge, so it returns an HTML challenge page instead of a country code and
   * detection would always fail. ip-api.com's free tier answers JSON directly; the tradeoff is
   * HTTP-only on that tier, acceptable for an outbound call carrying only an IP and receiving
   * only a country code.
   */
  private async fetchCountry(ip: string): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
      try {
        const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,countryCode`, {
          signal: controller.signal
        });
        // 429 is the free tier's quota response. Logged rather than swallowed: sustained quota
        // exhaustion means Indian buyers are being quoted USD, which is invisible otherwise.
        if (res.status === 429) {
          console.warn("[country-detection] ip-api quota exhausted — country detection degraded until it recovers");
          return null;
        }
        if (!res.ok) return null;
        const body = (await res.json()) as { status?: string; message?: string; countryCode?: string };
        if (body.status && body.status !== "success") {
          if (body.message) console.warn(`[country-detection] ip-api lookup failed: ${body.message}`);
          return null;
        }
        return this.normalizeCountry(body.countryCode);
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return null;
    }
  }

  private isPrivateIp(ip: string): boolean {
    return (
      ip === "127.0.0.1" ||
      ip === "::1" ||
      ip.startsWith("10.") ||
      ip.startsWith("192.168.") ||
      ip.startsWith("169.254.") ||
      ip.startsWith("fc") ||
      ip.startsWith("fd") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    );
  }
}
