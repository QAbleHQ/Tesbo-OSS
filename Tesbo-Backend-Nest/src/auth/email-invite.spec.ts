import { EmailService } from "./email.service";
import { AppConfigService } from "../config/app-config.service";

/**
 * EmailService.sendInvite builds the accept-invite email and (when a Postmark
 * token is configured) posts it to Postmark. No real network calls — fetch is
 * mocked, matching the "no real Postgres / no real network" rule for this suite.
 */
function makeService(configOverrides: Partial<Record<string, unknown>> = {}) {
  const config = {
    postmarkApiToken: "",
    postmarkFromEmail: "noreply@tesbo.io",
    otpExpiryMinutes: 10,
    ...configOverrides
  } as unknown as AppConfigService;
  return new EmailService(config);
}

describe("EmailService.sendInvite", () => {
  const originalFetch = global.fetch;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    logSpy.mockRestore();
  });

  it("logs the accept link instead of sending mail when no Postmark token is configured", async () => {
    global.fetch = jest.fn();
    const svc = makeService({ postmarkApiToken: "" });

    await svc.sendInvite("bob@example.com", "Alice", "qa_engineer", "Acme Corp", "raw-token-123", [], "https://app.tesbo.io");

    expect(global.fetch).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("https://app.tesbo.io/invite/raw-token-123"));
  });

  it("posts to Postmark with the accept URL, role label, and project names when a token is configured", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: jest.fn() });
    global.fetch = fetchMock as unknown as typeof fetch;
    const svc = makeService({ postmarkApiToken: "pm-token", postmarkFromEmail: "noreply@tesbo.io" });

    await svc.sendInvite(
      "bob@example.com",
      "Alice",
      "manager",
      "Acme Corp",
      "raw-token-123",
      ["Website", "Mobile"],
      "https://app.tesbo.io"
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.postmarkapp.com/email");
    expect(init.headers["X-Postmark-Server-Token"]).toBe("pm-token");
    const body = JSON.parse(init.body);
    expect(body.From).toBe("noreply@tesbo.io");
    expect(body.To).toBe("bob@example.com");
    expect(body.Subject).toBe("You have been invited to join Acme Corp");
    expect(body.TextBody).toContain("https://app.tesbo.io/invite/raw-token-123");
    expect(body.TextBody).toContain("Manager"); // role label mapping: manager -> "Manager"
    expect(body.HtmlBody).toContain("Website");
    expect(body.HtmlBody).toContain("Mobile");
  });

  it("labels any non-manager role as 'QA Engineer'", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: jest.fn() });
    global.fetch = fetchMock as unknown as typeof fetch;
    const svc = makeService({ postmarkApiToken: "pm-token" });

    await svc.sendInvite("bob@example.com", "Alice", "qa_engineer", "Acme Corp", "raw-token", [], "https://app.tesbo.io");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.TextBody).toContain("QA Engineer");
  });

  it("throws when Postmark rejects the request, surfacing the status and body", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 422, text: jest.fn().mockResolvedValue("Invalid From address") });
    global.fetch = fetchMock as unknown as typeof fetch;
    const svc = makeService({ postmarkApiToken: "pm-token" });

    await expect(
      svc.sendInvite("bob@example.com", "Alice", "qa_engineer", "Acme Corp", "raw-token", [], "https://app.tesbo.io")
    ).rejects.toThrow("Postmark returned 422: Invalid From address");
  });
});
