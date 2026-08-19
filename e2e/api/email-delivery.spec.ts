import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  backendLogsAvailable,
  readBackendLogs,
  readEmailDeliveryReport,
  waitForInviteLinkInLogs,
  waitForOtpInLogs,
} from "../utils/backend-logs";
import { env, testAddress } from "../utils/env";
import { clearOtpIpRateLimit, disposableEmail } from "../utils/otp";
import { dbControlAvailable, exec, execAllowingAuditImmutability, literal, scalar } from "../utils/psql";
import {
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  seedFixtureUser,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * Email delivery gating — the guard that stops a test run from bouncing mail off invented addresses.
 *
 * Background: this suite mints addresses that nobody reads. While a LIVE Postmark token sat in a
 * local .env, every signup, OTP and invite was a real delivery attempt; roughly 1100 bounces
 * accumulated and the sending account was flagged. The backend now decides per email whether it may
 * be handed to Postmark at all (Tesbo-Backend-Nest/src/config/email-delivery.policy.ts):
 *
 *   EMAIL_DELIVERY_MODE=live  → everything is delivered for real. Production only.
 *   EMAIL_DELIVERY_MODE=log   → the OTP is printed to the backend log and posted NOWHERE, and the
 *                               other emails are posted only once Postmark confirms the token
 *                               belongs to a SANDBOX server, which accepts sends and delivers to
 *                               nobody. A live token in this mode sends nothing at all.
 *
 * "log" is the default, so these tests assert the stack under test cannot email a real person — and
 * that the log really is a usable substitute for a mailbox, which is what the suite depends on.
 *
 * Everything here reads the backend container's stdout, so it needs `docker compose` and skips
 * against a remote target.
 */

const logsUnavailable = !backendLogsAvailable();
const SKIP_NO_LOGS =
  "needs `docker compose logs backend`, which is how the suite reads the mail the backend printed " +
  "instead of sending. Unavailable against a remote target.";

test.describe("email delivery gating", () => {
  test.skip(logsUnavailable, SKIP_NO_LOGS);

  test("the stack under test cannot deliver email to a real recipient", async () => {
    const report = readEmailDeliveryReport();
    expect(
      report,
      "the backend prints `[email] delivery mode=… postmark_server=… reach=…` on boot; not finding it " +
        "means either the container has restarted past the line or the boot log was removed",
    ).not.toBeNull();

    // The assertion this file exists for. "recipients" means a real mailbox would receive whatever
    // this suite generates next — which is how the bounce incident happened.
    expect(
      report!.reach,
      `email reach is "${report!.reach}" (mode=${report!.mode} server=${report!.server}) — this stack ` +
        "would deliver test mail to real addresses. Point POSTMARK_API_TOKEN at a Postmark sandbox " +
        "server and leave EMAIL_DELIVERY_MODE unset (or =log) before running this suite.",
    ).not.toBe("recipients");

    if (report!.mode === "log" && report!.server !== "not_configured") {
      // In log mode a non-sandbox token doesn't leak mail — it's refused — but it does mean the
      // invite/billing sends are silently not being exercised at all, so say so.
      expect(
        report!.server,
        "log mode only replays invite/billing email through a SANDBOX server; with any other token " +
          "those sends are blocked entirely and this suite stops covering the real Postmark path",
      ).toBe("sandbox");
    }
  });

  test("a sandbox-configured stack logs no delivery-blocked warnings", async () => {
    const report = readEmailDeliveryReport();
    test.skip(report?.server !== "sandbox", "only meaningful when a sandbox server is configured");

    // The policy warns once per process when it refuses to post. Against a sandbox server it never
    // should — a warning here means the probe is failing and invite/billing mail isn't being sent.
    expect(readBackendLogs(20_000) ?? "").not.toContain("[email] Blocking delivery");
  });

  test("an OTP is printed to the log and never emailed, and the printed code works", async ({ playwright }) => {
    clearOtpIpRateLimit();
    const anon = await playwright.request.newContext({
      baseURL: env.apiBaseUrl,
      // request.newContext() otherwise inherits account A's session from playwright.config.ts.
      storageState: { cookies: [], origins: [] },
    });
    const email = disposableEmail("email-delivery-otp");

    try {
      const requestRes = await anon.post("/api/auth/otp/request", { data: { email }, failOnStatusCode: false });
      expect(requestRes.status(), await requestRes.text()).toBe(204);

      // The code never comes back in the response — the whole point is that it travels out of band.
      expect(await requestRes.text()).not.toMatch(/\d{6}/);

      const code = await waitForOtpInLogs(email);
      expect(
        code,
        "the backend did not print an OTP for this address. In log mode it always should; if this " +
          "stack is on EMAIL_DELIVERY_MODE=live the code went out as a real email instead.",
      ).not.toBeNull();

      // Proves the logged code is the real one, not a placeholder: it completes a sign-in.
      const verifyRes = await anon.post("/api/auth/otp/verify", { data: { email, code }, failOnStatusCode: false });
      expect(verifyRes.ok(), `verifying the logged code failed: ${verifyRes.status()} ${await verifyRes.text()}`).toBeTruthy();

      const me = await anon.get("/api/auth/me");
      expect(me.ok()).toBeTruthy();
      expect((await me.json()).email).toBe(email);
    } finally {
      clearOtpIpRateLimit();
      // OTP sign-in auto-creates the account, so this disposable user has to be swept up.
      if (dbControlAvailable()) execAllowingAuditImmutability(`DELETE FROM users WHERE email = ${literal(email)};`);
      await anon.dispose();
    }
  });

  test("a wrong code is still rejected when the right one is sitting in the log", async ({ playwright }) => {
    clearOtpIpRateLimit();
    const anon = await playwright.request.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });
    const email = disposableEmail("email-delivery-otp-wrong");

    try {
      expect((await anon.post("/api/auth/otp/request", { data: { email } })).status()).toBe(204);
      const code = await waitForOtpInLogs(email);
      expect(code).not.toBeNull();

      // Deliberately a different six-digit code from the logged one.
      const wrong = code === "000000" ? "111111" : "000000";
      const res = await anon.post("/api/auth/otp/verify", { data: { email, code: wrong }, failOnStatusCode: false });
      expect(res.status()).toBe(401);
    } finally {
      clearOtpIpRateLimit();
      if (dbControlAvailable()) execAllowingAuditImmutability(`DELETE FROM users WHERE email = ${literal(email)};`);
      await anon.dispose();
    }
  });
});

test.describe("invite email in log mode", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("email-delivery");
    if (tenant) asOwner = await loginAs(tenant.owner);
  });

  test.afterAll(async () => {
    await asOwner?.dispose();
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(!!reason, reason ?? "");
    test.skip(logsUnavailable, SKIP_NO_LOGS);
  });

  test("the accept link is printed to the log and the printed token actually works", async ({ playwright }) => {
    const email = testAddress(`email-delivery-invite-${Date.now()}`);
    let inviteId: string | null = null;
    const anon = await playwright.request.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const res = await asOwner.post("/api/workspace/invitations", {
        data: { email, role: "qa_engineer" },
        failOnStatusCode: false,
      });
      expect(res.ok(), `invite failed: ${res.status()} ${await res.text()}`).toBeTruthy();
      inviteId = (await res.json()).id;

      const link = await waitForInviteLinkInLogs(email);
      expect(
        link,
        "the backend did not print the invite accept link. In log mode it always should — and with " +
          "nothing delivered, the log is the only place that link exists.",
      ).not.toBeNull();

      // The link is what an invitee would click, so assert on it as a whole, not just its token.
      expect(link).toContain("/invite/");
      const token = link!.split("/invite/")[1];
      expect(token, "the printed link carries no token").toBeTruthy();

      // Deliberately anonymous: the invite landing page renders before the invitee has a session.
      const lookup = await anon.get(`/api/invitations/${token}`, { failOnStatusCode: false });
      expect(
        lookup.ok(),
        `the token printed to the log did not resolve: ${lookup.status()} ${await lookup.text()}`,
      ).toBeTruthy();
      expect((await lookup.json()).email).toBe(email);
    } finally {
      // Cancel rather than accept: accepting would repoint the invitee's active workspace.
      if (inviteId) {
        await asOwner.delete(`/api/workspace/invitations/${inviteId}`, { failOnStatusCode: false });
      }
      await anon.dispose();
    }
  });
});

test.describe("the admin health endpoint reports email delivery", () => {
  // /api/admin/system/health is gated on a platform_admins row, so this needs a disposable user
  // granted that flag and stripped of it again. Never account A: platform admin outlives the test.
  let admin: { email: string; userId: string } | null = null;
  let asAdmin: APIRequestContext | null = null;

  test.beforeAll(async () => {
    if (!dbControlAvailable()) return;
    admin = seedFixtureUser(testAddress(`email-delivery-admin-${Date.now()}`), "E2E Email Delivery Admin");
    exec(
      `INSERT INTO platform_admins (user_id) VALUES (${literal(admin.userId)}) ON CONFLICT DO NOTHING;`,
    );
    asAdmin = await loginAs(admin);
  });

  test.afterAll(async () => {
    await asAdmin?.dispose();
    if (admin && dbControlAvailable()) {
      exec(`DELETE FROM platform_admins WHERE user_id = ${literal(admin.userId)};`);
      execAllowingAuditImmutability(`DELETE FROM users WHERE id = ${literal(admin.userId)};`);
    }
  });

  test.beforeEach(() => {
    test.skip(
      !dbControlAvailable(),
      "needs `docker compose exec postgres psql` to grant a disposable user platform-admin",
    );
  });

  test("reports the delivery mode, the Postmark server type, and how far mail gets", async () => {
    const res = await asAdmin!.get("/api/admin/system/health", { failOnStatusCode: false });
    expect(res.ok(), `${res.status()} ${await res.text()}`).toBeTruthy();

    const body = await res.json();
    expect(body.services.email).toMatchObject({
      provider: "postmark",
      mode: expect.stringMatching(/^(live|log)$/),
      server: expect.stringMatching(/^(sandbox|live|unknown|not_configured)$/),
      reach: expect.stringMatching(/^(recipients|sandbox_only|log_only)$/),
    });

    // Same guarantee as the boot-log test, asserted through the API an operator would actually check.
    expect(body.services.email.reach, "this stack would deliver test mail to real addresses").not.toBe(
      "recipients",
    );

    // The report has to agree with what the backend announced at boot — one of them being stale
    // would make both useless as a safety check.
    const booted = readEmailDeliveryReport();
    if (booted) {
      expect(body.services.email.mode).toBe(booted.mode);
      expect(body.services.email.server).toBe(booted.server);
      expect(body.services.email.reach).toBe(booted.reach);
    }

    // The platform-admin grant is what makes this reachable at all — confirm it's really in place
    // rather than the endpoint having quietly stopped checking.
    expect(scalar(`SELECT count(*) FROM platform_admins WHERE user_id = ${literal(admin!.userId)};`)).toBe("1");
  });

  test("stays closed to callers who are not platform admins", async ({ request, playwright }) => {
    // api/tail.spec.ts asserts these two statuses as part of its authorization sweep; repeated here
    // because this endpoint now hands back platform-wide email configuration, so the gate protecting
    // it belongs to this change too.
    const anon = await playwright.request.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });
    try {
      expect((await anon.get("/api/admin/system/health", { failOnStatusCode: false })).status()).toBe(401);
      // Account A owns a workspace but is not a platform admin — workspace ownership must not be
      // enough to read how the platform sends mail.
      expect((await request.get("/api/admin/system/health", { failOnStatusCode: false })).status()).toBe(401);
    } finally {
      await anon.dispose();
    }
  });
});
