import { AppConfigService } from "./app-config.service";
import { EmailDeliveryPolicy } from "./email-delivery.policy";

/**
 * The guard that stops a test run from bouncing mail off invented addresses.
 *
 * Every branch of the decision table is covered here, including the two that historically went
 * wrong: a LIVE token configured on a stack nobody meant to send from, and a Postmark that can't be
 * reached (which must block, not wave the send through). No real network — fetch is mocked.
 */
function makePolicy(overrides: Partial<Record<string, unknown>> = {}) {
  const config = {
    postmarkApiToken: "pm-token",
    emailDeliveryMode: "log",
    ...overrides
  } as unknown as AppConfigService;
  return new EmailDeliveryPolicy(config);
}

function serverResponse(deliveryType: unknown) {
  return { ok: true, json: jest.fn().mockResolvedValue({ DeliveryType: deliveryType }) };
}

describe("EmailDeliveryPolicy", () => {
  const originalFetch = global.fetch;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    errorSpy.mockRestore();
  });

  describe("live mode", () => {
    it("posts every kind of email without even asking what server the token belongs to", async () => {
      const fetchMock = jest.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
      const policy = makePolicy({ emailDeliveryMode: "live" });

      await expect(policy.decide("otp")).resolves.toEqual({ post: true });
      await expect(policy.decide("communication")).resolves.toEqual({ post: true });
      // The probe is a cost paid only where it changes the answer; in live mode it never can.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("still sends nothing when no token is configured", async () => {
      const policy = makePolicy({ emailDeliveryMode: "live", postmarkApiToken: "" });
      await expect(policy.decide("communication")).resolves.toEqual({ post: false, reason: "no_token" });
    });
  });

  describe("log mode", () => {
    it("never posts an OTP anywhere, not even to a sandbox server", async () => {
      const fetchMock = jest.fn().mockResolvedValue(serverResponse("Sandbox"));
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(makePolicy().decide("otp")).resolves.toEqual({ post: false, reason: "log_mode_otp" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("posts other emails once Postmark confirms the server is a sandbox", async () => {
      global.fetch = jest.fn().mockResolvedValue(serverResponse("Sandbox")) as unknown as typeof fetch;

      await expect(makePolicy().decide("communication")).resolves.toEqual({ post: true });
    });

    it("blocks a LIVE server and says so loudly — the bounce incident this exists to prevent", async () => {
      global.fetch = jest.fn().mockResolvedValue(serverResponse("Live")) as unknown as typeof fetch;

      await expect(makePolicy().decide("communication")).resolves.toEqual({
        post: false,
        reason: "not_a_sandbox_server"
      });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("LIVE server"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("EMAIL_DELIVERY_MODE=live"));
    });

    it("blocks when the server type can't be read, rather than assuming it is safe", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND")) as unknown as typeof fetch;

      await expect(makePolicy().decide("communication")).resolves.toEqual({
        post: false,
        reason: "not_a_sandbox_server"
      });
    });

    it("blocks when Postmark rejects the token", async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, json: jest.fn() }) as unknown as typeof fetch;

      await expect(makePolicy().decide("communication")).resolves.toEqual({
        post: false,
        reason: "not_a_sandbox_server"
      });
    });

    it("blocks a delivery type it doesn't recognise", async () => {
      global.fetch = jest.fn().mockResolvedValue(serverResponse("SomethingNew")) as unknown as typeof fetch;

      await expect(makePolicy().serverKind()).resolves.toBe("unknown");
    });

    it("warns once per server kind, not once per email", async () => {
      global.fetch = jest.fn().mockResolvedValue(serverResponse("Live")) as unknown as typeof fetch;
      const policy = makePolicy();

      for (let i = 0; i < 5; i += 1) await policy.decide("communication");

      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("the server-type probe", () => {
    it("is made once and reused, and is shared by concurrent sends", async () => {
      const fetchMock = jest.fn().mockResolvedValue(serverResponse("Sandbox"));
      global.fetch = fetchMock as unknown as typeof fetch;
      const policy = makePolicy();

      await Promise.all([
        policy.decide("communication"),
        policy.decide("communication"),
        policy.decide("communication")
      ]);
      await policy.decide("communication");

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("sends the token as the Postmark server token and gives up quickly", async () => {
      const fetchMock = jest.fn().mockResolvedValue(serverResponse("Sandbox"));
      global.fetch = fetchMock as unknown as typeof fetch;

      await makePolicy({ postmarkApiToken: "sandbox-token" }).serverKind();

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.postmarkapp.com/server");
      expect(init.headers["X-Postmark-Server-Token"]).toBe("sandbox-token");
      // Without a timeout an unreachable Postmark would hold an invite request open indefinitely.
      expect(init.signal).toBeDefined();
    });

    it("retries after a failure instead of pinning the answer to unknown for the process's life", async () => {
      const fetchMock = jest
        .fn()
        .mockRejectedValueOnce(new Error("network blip"))
        .mockResolvedValue(serverResponse("Sandbox"));
      global.fetch = fetchMock as unknown as typeof fetch;
      const policy = makePolicy();

      await expect(policy.serverKind()).resolves.toBe("unknown");
      await expect(policy.serverKind()).resolves.toBe("sandbox");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("doesn't call Postmark at all when no token is configured", async () => {
      const fetchMock = jest.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(makePolicy({ postmarkApiToken: "" }).serverKind()).resolves.toBe("not_configured");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("describe() — what the health endpoint and the boot log report", () => {
    it("reports reach=recipients only for a live mode against a live server", async () => {
      global.fetch = jest.fn().mockResolvedValue(serverResponse("Live")) as unknown as typeof fetch;

      await expect(makePolicy({ emailDeliveryMode: "live" }).describe()).resolves.toEqual({
        mode: "live",
        server: "live",
        reach: "recipients"
      });
    });

    it("reports sandbox_only for a live mode that is pointed at a sandbox server", async () => {
      global.fetch = jest.fn().mockResolvedValue(serverResponse("Sandbox")) as unknown as typeof fetch;

      await expect(makePolicy({ emailDeliveryMode: "live" }).describe()).resolves.toMatchObject({
        reach: "sandbox_only"
      });
    });

    it("reports sandbox_only for the normal test configuration", async () => {
      global.fetch = jest.fn().mockResolvedValue(serverResponse("Sandbox")) as unknown as typeof fetch;

      await expect(makePolicy().describe()).resolves.toEqual({
        mode: "log",
        server: "sandbox",
        reach: "sandbox_only"
      });
    });

    it("reports log_only for a log mode holding a live token — nothing gets out", async () => {
      global.fetch = jest.fn().mockResolvedValue(serverResponse("Live")) as unknown as typeof fetch;

      await expect(makePolicy().describe()).resolves.toMatchObject({ server: "live", reach: "log_only" });
    });

    it("reports log_only when no token is configured at all", async () => {
      await expect(makePolicy({ postmarkApiToken: "" }).describe()).resolves.toEqual({
        mode: "log",
        server: "not_configured",
        reach: "log_only"
      });
    });

    it("errs towards recipients when a live mode's probe failed — the send does go out", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("blip")) as unknown as typeof fetch;

      await expect(makePolicy({ emailDeliveryMode: "live" }).describe()).resolves.toMatchObject({
        server: "unknown",
        reach: "recipients"
      });
    });
  });
});

// Reads the real env, so it assumes no Tesbo-Backend-Nest/.env exists — AppConfigService gives a
// dotenv file precedence over process.env, and one containing EMAIL_DELIVERY_MODE would shadow these.
describe("AppConfigService.emailDeliveryMode", () => {
  const originalMode = process.env.EMAIL_DELIVERY_MODE;

  afterEach(() => {
    if (originalMode === undefined) delete process.env.EMAIL_DELIVERY_MODE;
    else process.env.EMAIL_DELIVERY_MODE = originalMode;
  });

  // The whole design rests on this: anything that isn't an explicit, well-formed "live" has to mean
  // "log". A typo in a deploy env must cost a quiet mailbox, never 1100 bounces.
  it.each([
    ["live", "live"],
    ["LIVE", "live"],
    ["  live  ", "live"],
    ["log", "log"],
    ["", "log"],
    ["liv", "log"],
    ["sandbox", "log"],
    ["true", "log"]
  ])("reads %p as %p", (raw, expected) => {
    process.env.EMAIL_DELIVERY_MODE = raw;
    expect(new AppConfigService().emailDeliveryMode).toBe(expected);
  });

  it("defaults to log when the variable is absent", () => {
    delete process.env.EMAIL_DELIVERY_MODE;
    expect(new AppConfigService().emailDeliveryMode).toBe("log");
  });
});
