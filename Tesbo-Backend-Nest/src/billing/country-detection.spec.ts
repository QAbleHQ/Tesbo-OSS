import type { AppConfigService } from "../config/app-config.service";
import { CountryDetectionService } from "./country-detection.service";

function makeConfig(overrides: Partial<AppConfigService> = {}): AppConfigService {
  return {
    billingForceCountry: "",
    trustProxyCountryHeader: false,
    ...overrides
  } as unknown as AppConfigService;
}

const PUBLIC_IP = "49.36.1.1";

function req(ip: string, headers: Record<string, string> = {}) {
  return { ip, headers } as never;
}

/** Stubs global fetch with a queue of responses, and counts calls. */
function stubFetch(responses: Array<{ status?: number; body?: unknown }>) {
  let call = 0;
  const spy = jest.fn(() => {
    const r = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return Promise.resolve({
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: () => Promise.resolve(r.body ?? {})
    } as Response);
  });
  global.fetch = spy as unknown as typeof fetch;
  return { spy, callCount: () => call };
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("country detection precedence", () => {
  it("uses the operator override above everything else", async () => {
    stubFetch([{ body: { status: "success", countryCode: "US" } }]);
    const svc = new CountryDetectionService(makeConfig({ billingForceCountry: "IN" }));
    const r = await svc.resolve(req(PUBLIC_IP), "US");
    expect(r).toEqual({ country: "IN", source: "override", detected: null });
  });

  it("ignores edge country headers unless header trust is enabled", async () => {
    stubFetch([{ body: { status: "success", countryCode: "US" } }]);
    const svc = new CountryDetectionService(makeConfig());
    const r = await svc.resolve(req(PUBLIC_IP, { "cf-ipcountry": "IN" }));
    expect(r.source).toBe("ip");
    expect(r.country).toBe("US");
  });

  it("trusts edge country headers when explicitly enabled", async () => {
    stubFetch([{ body: { status: "success", countryCode: "US" } }]);
    const svc = new CountryDetectionService(makeConfig({ trustProxyCountryHeader: true }));
    const r = await svc.resolve(req(PUBLIC_IP, { "cf-ipcountry": "IN" }));
    expect(r).toEqual({ country: "IN", source: "edge-header", detected: "IN" });
  });

  it("treats Cloudflare's XX/T1 placeholders as no answer", async () => {
    stubFetch([{ body: { status: "success", countryCode: "US" } }]);
    const svc = new CountryDetectionService(makeConfig({ trustProxyCountryHeader: true }));
    const r = await svc.resolve(req(PUBLIC_IP, { "cf-ipcountry": "XX" }));
    expect(r.source).toBe("ip");
  });

  it("falls back to the declared country only when no hard signal exists", async () => {
    stubFetch([{ body: { status: "fail", message: "reserved range" } }]);
    const svc = new CountryDetectionService(makeConfig());
    const r = await svc.resolve(req("10.0.0.5"), "IN");
    expect(r).toEqual({ country: "IN", source: "declared", detected: null });
  });

  it("never lets a declared country override a contradicting IP result", async () => {
    stubFetch([{ body: { status: "success", countryCode: "US" } }]);
    const svc = new CountryDetectionService(makeConfig());
    const r = await svc.resolve(req(PUBLIC_IP), "IN");
    expect(r.country).toBe("US");
    expect(r.source).toBe("ip");
  });

  it("fails closed when nothing is available", async () => {
    const svc = new CountryDetectionService(makeConfig());
    const r = await svc.resolve(req("127.0.0.1"));
    expect(r).toEqual({ country: null, source: "unknown", detected: null });
  });
});

describe("lookup caching", () => {
  it("serves a successful lookup from cache instead of re-querying", async () => {
    const { callCount } = stubFetch([{ body: { status: "success", countryCode: "IN" } }]);
    const svc = new CountryDetectionService(makeConfig());
    expect((await svc.resolve(req(PUBLIC_IP))).country).toBe("IN");
    expect((await svc.resolve(req(PUBLIC_IP))).country).toBe("IN");
    expect(callCount()).toBe(1);
  });

  it("collapses concurrent lookups for the same IP into one upstream call", async () => {
    const { callCount } = stubFetch([{ body: { status: "success", countryCode: "IN" } }]);
    const svc = new CountryDetectionService(makeConfig());
    const results = await Promise.all([svc.resolve(req(PUBLIC_IP)), svc.resolve(req(PUBLIC_IP)), svc.resolve(req(PUBLIC_IP))]);
    expect(results.map((r) => r.country)).toEqual(["IN", "IN", "IN"]);
    expect(callCount()).toBe(1);
  });

  /*
   * The regression this guards: a transient quota error used to be cached for the full 6-hour
   * success TTL, so a few seconds of upstream trouble silently degraded pricing for hours. Failures
   * must expire in about a minute so detection self-heals.
   */
  it("retries quickly after a failed lookup rather than caching it for hours", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { callCount } = stubFetch([{ status: 429 }, { body: { status: "success", countryCode: "IN" } }]);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const svc = new CountryDetectionService(makeConfig());

    expect((await svc.resolve(req(PUBLIC_IP))).source).toBe("unknown");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("quota exhausted"));

    // Still cached a few seconds later — one blip shouldn't hammer upstream.
    jest.setSystemTime(new Date("2026-01-01T00:00:10Z"));
    expect((await svc.resolve(req(PUBLIC_IP))).source).toBe("unknown");
    expect(callCount()).toBe(1);

    // Recovered just over a minute later.
    jest.setSystemTime(new Date("2026-01-01T00:01:05Z"));
    expect((await svc.resolve(req(PUBLIC_IP))).country).toBe("IN");
    expect(callCount()).toBe(2);
  });

  it("holds a successful lookup well past the failure TTL", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { callCount } = stubFetch([{ body: { status: "success", countryCode: "IN" } }]);
    const svc = new CountryDetectionService(makeConfig());
    expect((await svc.resolve(req(PUBLIC_IP))).country).toBe("IN");

    jest.setSystemTime(new Date("2026-01-01T00:30:00Z"));
    expect((await svc.resolve(req(PUBLIC_IP))).country).toBe("IN");
    expect(callCount()).toBe(1);
  });

  it("does not call out for private or loopback addresses", async () => {
    const { callCount } = stubFetch([{ body: { status: "success", countryCode: "IN" } }]);
    const svc = new CountryDetectionService(makeConfig());
    for (const ip of ["127.0.0.1", "::1", "10.1.2.3", "192.168.1.5", "172.21.0.1", "169.254.1.1", "::ffff:127.0.0.1"]) {
      expect((await svc.resolve(req(ip))).country).toBeNull();
    }
    expect(callCount()).toBe(0);
  });
});
