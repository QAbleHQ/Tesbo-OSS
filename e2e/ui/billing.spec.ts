import {
  expect,
  request as pwRequest,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { env } from "../utils/env";
import {
  activeProjectIdsOldestFirst,
  billingModuleUnavailableReason,
  billingSuitePrerequisites,
  billingTenant,
  insertBillingAuditEntry,
  isoDaysFromNow,
  readBillingState,
  resetToLaunch,
  setBillingState,
  setGraceWindow,
  setProPlan,
  type BillingState,
} from "../utils/billing-db";

/*
 * The billing settings screen in every plan state a customer can actually land in.
 *
 * These states are what a paying customer sees at the worst moment — card declined, subscription
 * lapsed, limits now applying — so the wording and the call to action matter as much as the data.
 * Each test puts the workspace into one state via its billing columns, loads the tab, and checks the
 * screen tells the truth about it and offers a way forward.
 *
 * Runs against its own disposable workspace (see env.billingUiEmail), never the shared smoke one:
 * playwright.config.ts runs spec FILES in parallel, so a workspace shared with the API billing suite
 * would have its plan changed underneath these assertions.
 *
 * No Stripe writes. The one action that would reach Stripe — "Manage billing" — is only clicked in
 * the state where the handler refuses before calling it, which is itself a case worth covering.
 */

const tenant = billingTenant("ui");
const skipReason = billingSuitePrerequisites(tenant);

const BILLING_URL = "/settings?tab=billing";

/** Mirrors PricingModal's own formatting, so the assertion is "shows the quoted price", not "shows a number". */
function formatAmount(amountMajor: number, currency: string): string {
  const locale = currency === "inr" ? "en-IN" : "en-US";
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: Number.isInteger(amountMajor) ? 0 : 2,
  }).format(amountMajor);
}

function currencySymbol(currency: string): string {
  return currency === "inr" ? "₹" : "$";
}

test.describe("billing settings", () => {
  test.skip(!!skipReason, skipReason ?? undefined);

  const orgId = tenant?.organizationId ?? "";

  let context: BrowserContext;
  let page: Page;
  let api: APIRequestContext;
  let snapshot: BillingState;
  let unavailableReason: string | null = null;

  test.beforeAll(async ({ browser }) => {
    // The `page` fixture would carry the shared smoke account's session from playwright.config.ts;
    // this suite needs the disposable billing tenant's instead. Its session cookie is host-scoped to
    // localhost, so the state saved against the API origin is sent to the frontend origin too.
    context = await browser.newContext({
      baseURL: env.webBaseUrl,
      storageState: tenant!.storageStatePath,
    });
    page = await context.newPage();
    api = await pwRequest.newContext({
      baseURL: env.apiBaseUrl,
      storageState: tenant!.storageStatePath,
    });
    unavailableReason = await billingModuleUnavailableReason(api);
    if (unavailableReason) return;
    snapshot = readBillingState(orgId);
  });

  test.beforeEach(() => {
    test.skip(!!unavailableReason, unavailableReason ?? undefined);
  });

  test.afterAll(async () => {
    if (!unavailableReason) setBillingState(orgId, snapshot);
    await api.dispose();
    await context.close();
  });

  /** The PricingModal panel — Modal renders into a body portal with no dialog role. */
  function pricingModal() {
    return page.locator('div[role="presentation"] > div[role="presentation"]');
  }

  async function openBillingTab() {
    await page.goto(BILLING_URL);
    // The tab renders a "Loading…" placeholder until billing + usage have both settled.
    await expect(page.getByRole("heading", { name: "Billing", exact: true })).toBeVisible();
  }

  test("the Launch plan card explains the free plan and offers the upgrade", async () => {
    resetToLaunch(orgId);
    await openBillingTab();

    await expect(page.getByText(/Free forever — up to 2 projects and 500MB storage/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Upgrade to Pro" })).toBeVisible();
    // No plan to manage yet, so the portal entry point must not be offered.
    await expect(page.getByRole("button", { name: "Manage billing" })).toHaveCount(0);
  });

  test("usage bars report the ceilings actually in force", async () => {
    resetToLaunch(orgId);
    await openBillingTab();

    await expect(page.getByRole("heading", { name: "Usage" })).toBeVisible();
    await expect(page.getByText("Projects", { exact: true })).toBeVisible();
    await expect(page.getByText("Storage", { exact: true })).toBeVisible();
    // Launch: 2 projects, 500MB. The numbers next to the bars are what a customer uses to decide
    // whether they need to upgrade, so they have to match the API's limits.
    await expect(page.getByText("/ 2", { exact: false })).toBeVisible();
    await expect(page.getByText("500 MB", { exact: false })).toBeVisible();

    setProPlan(orgId);
    await openBillingTab();
    // Pro reports unlimited projects rather than a bar that can never fill.
    await expect(page.getByText("· unlimited")).toBeVisible();
    await expect(page.getByText("5.0 GB", { exact: false })).toBeVisible();
  });

  test("hitting the Launch project limit points at the upgrade", async () => {
    setProPlan(orgId);
    const created = await api.post("/api/projects", {
      data: { name: `E2E Billing UI Limit ${Date.now()}`, key: `BILU${`${Date.now()}`.slice(-8)}` },
      failOnStatusCode: false,
    });
    expect(created.ok()).toBeTruthy();
    const projectId = (await created.json()).id;

    try {
      resetToLaunch(orgId);
      await openBillingTab();
      await expect(page.getByText(/reached the Launch plan.s 2-project limit/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Upgrade to Pro" }).last()).toBeVisible();
    } finally {
      setProPlan(orgId);
      await api.delete(`/api/projects/${projectId}`, { failOnStatusCode: false });
    }
  });

  test("the Pro plan card shows the renewal date and the way to manage the subscription", async () => {
    setProPlan(orgId, { billing_interval: "annual", current_period_end: isoDaysFromNow(200) });
    await openBillingTab();

    // Deliberately loose on the interval word — see the copy test below.
    await expect(page.getByText(/Renews \w+ \d{1,2}, \d{4} · billed annual/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Manage billing" })).toBeVisible();
    // Already on the top plan — offering an upgrade would send them into a duplicate subscription.
    await expect(page.getByRole("button", { name: "Upgrade to Pro" })).toHaveCount(0);
  });

  test("the renewal line reads as a sentence for both billing intervals", async () => {
    test.fail();
    // KNOWN GAP: BillingTab.tsx interpolates the raw billingInterval into "billed {interval}", so an
    // annual subscription reads "billed annual" instead of "billed annually". Monthly happens to
    // read correctly, which is why this went unnoticed. Fixing it is a one-word change at
    // Tesbo-Frontend/components/settings/BillingTab.tsx:256 — at which point Playwright reports this
    // case as "unexpectedly passing", and that's the cue to delete the test.fail() above.
    setProPlan(orgId, { billing_interval: "annual", current_period_end: isoDaysFromNow(200) });
    await openBillingTab();
    await expect(page.getByText(/billed annually/)).toBeVisible();
  });

  test("a scheduled cancellation is shown on the plan card without removing access", async () => {
    setProPlan(orgId, { cancel_at_period_end: true, current_period_end: isoDaysFromNow(12) });
    await openBillingTab();

    await expect(page.getByText(/^Cancels /)).toBeVisible();
    // Still Pro until the period ends, so the manage entry point stays.
    await expect(page.getByRole("button", { name: "Manage billing" })).toBeVisible();
  });

  test("opening the billing portal without a billing account reports why instead of failing silently", async () => {
    setProPlan(orgId, { stripe_customer_id: null });
    await openBillingTab();

    // Refused server-side before any Stripe call, which is what makes this safe to click here. The
    // point of the test is that the failure surfaces on screen rather than leaving a dead button.
    await page.getByRole("button", { name: "Manage billing" }).click();
    await expect(page.getByText(/no billing account yet/)).toBeVisible();
  });

  test("a failed payment is impossible to miss and offers to fix the card", async () => {
    setProPlan(orgId, { payment_failed_at: isoDaysFromNow(-2) });
    await openBillingTab();

    await expect(page.getByText(/couldn.t process your last payment/)).toBeVisible();
    // Access continues while Stripe retries — the banner has to say so, or a customer assumes
    // they've already lost the workspace.
    await expect(page.getByText(/Pro access continues while we retry/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Update payment method" })).toBeVisible();
  });

  test("an open grace window names the deadline and offers to resubscribe", async () => {
    setGraceWindow(orgId, 9);
    await openBillingTab();

    await expect(page.getByText(/Your Pro subscription has ended — full access until .+/)).toBeVisible();
    // The reassurance is the substance here: nothing is gone and nothing has changed yet.
    await expect(page.getByText(/Nothing has been deleted and everything still works as before/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Resubscribe to Pro" })).toBeVisible();
  });

  test("a closed grace window leads with the data being safe", async () => {
    setGraceWindow(orgId, -1);
    await openBillingTab();

    await expect(page.getByText("Launch plan limits are now in effect")).toBeVisible();
    await expect(page.getByText(/Your data is safe — nothing has been deleted/)).toBeVisible();
    await expect(page.getByText(/Upgrading restores full access immediately/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Upgrade to Pro" }).first()).toBeVisible();
  });

  test("the billing activity timeline renders what happened and when", async () => {
    resetToLaunch(orgId);
    const marker = `Payment received — $360 (${Date.now()})`;
    insertBillingAuditEntry(orgId, "billing_payment_succeeded", marker);

    await openBillingTab();
    await expect(page.getByRole("heading", { name: "Billing activity" })).toBeVisible();
    await expect(page.getByText(marker)).toBeVisible();
  });

  test("returning from a cancelled checkout says nothing changed", async () => {
    resetToLaunch(orgId);
    await page.goto(`${BILLING_URL}&checkout=cancelled`);

    await expect(page.getByText("Checkout was cancelled — no changes were made.")).toBeVisible();
    // The query param is cleared so a refresh doesn't replay the toast.
    await expect(page).toHaveURL(/\/settings\?tab=billing$/);
  });

  test("returning from a successful checkout reports the real outcome, not an assumed one", async () => {
    resetToLaunch(orgId);
    await page.goto(`${BILLING_URL}&checkout=success`);

    // The redirect is not proof of anything — the plan only flips when Stripe confirms it. This
    // workspace has no subscription to find, so the honest answer is "still activating" rather than
    // a "Welcome aboard" the next page load would contradict.
    await expect(page.getByText(/still activating your plan/)).toBeVisible();
    await expect(page.getByText("Launch", { exact: true }).first()).toBeVisible();
    await expect(page).toHaveURL(/\/settings\?tab=billing$/);
  });

  test.describe("the pricing modal", () => {
    test("quotes the plan in the currency the server resolved, for both intervals", async () => {
      resetToLaunch(orgId);
      const pricing = await (await api.get("/api/billing/pricing")).json();
      test.skip(
        pricing.monthlyAmount === null || pricing.annualAmount === null,
        "needs Stripe prices configured for this environment to quote against",
      );

      await openBillingTab();
      await page.getByRole("button", { name: "Upgrade to Pro" }).click();

      const modal = pricingModal();
      await expect(modal.getByText("Test management that scales, without the pricing maze.")).toBeVisible();

      // Annual is the default. The upgrade button stays disabled until the quote lands, so waiting
      // for it to enable is also the assertion that the amount on screen is the resolved one and not
      // the hard-coded fallback.
      const upgrade = modal.getByRole("button", { name: "Upgrade to Pro" });
      await expect(upgrade).toBeEnabled();

      const symbol = currencySymbol(pricing.currency);
      const annualTotal = pricing.annualAmount / 100;
      const annualPerMonth = annualTotal / 12;
      await expect(modal.getByText(`${symbol}${formatAmount(annualPerMonth, pricing.currency)}`)).toBeVisible();
      await expect(
        modal.getByText(`Billed annually at ${symbol}${formatAmount(annualTotal, pricing.currency)}/year.`),
      ).toBeVisible();

      await modal.getByRole("button", { name: "Monthly" }).click();
      await expect(
        modal.getByText(`${symbol}${formatAmount(pricing.monthlyAmount / 100, pricing.currency)}`),
      ).toBeVisible();
      await expect(modal.getByText("Billed monthly.")).toBeVisible();
    });

    test("the India-pricing option appears only when the server allows INR", async () => {
      resetToLaunch(orgId);
      const pricing = await (await api.get("/api/billing/pricing")).json();

      await openBillingTab();
      await page.getByRole("button", { name: "Upgrade to Pro" }).click();
      const modal = pricingModal();
      await expect(modal.getByText("Test management that scales, without the pricing maze.")).toBeVisible();

      const indiaToggle = modal.locator('input[type="checkbox"]');
      if (pricing.inrAvailable) {
        // Offered because the server independently placed this visitor in India — ticking it is a
        // request the server will honour.
        await expect(indiaToggle).toBeVisible();
        await expect(modal.getByText(/I.m in India/)).toBeVisible();
      } else {
        // Never offered otherwise: the server would refuse an INR request from here, so showing the
        // toggle would only produce an error the visitor can't act on.
        await expect(indiaToggle).toHaveCount(0);
      }
    });

    test("the current plan is marked and can't be bought again", async () => {
      setProPlan(orgId);
      await openBillingTab();
      // On Pro the plan card offers "Manage billing"; the modal is reachable from the banners, so
      // drive it from the grace state where "Resubscribe to Pro" opens the same modal.
      setGraceWindow(orgId, 5);
      await openBillingTab();
      await page.getByRole("button", { name: "Resubscribe to Pro" }).click();

      const modal = pricingModal();
      // Launch is the billed plan during a grace window, so it's the one marked current — and its
      // button is inert either way, since there's nothing to buy.
      await expect(modal.getByRole("button", { name: "Current plan" })).toBeDisabled();
    });
  });

  test.describe("read-only projects after a downgrade", () => {
    test("a locked project is still fully readable in the UI", async () => {
      // Arrange three projects so the newest is beyond the Launch allowance, then close the window.
      setProPlan(orgId);
      const created: string[] = [];
      while (activeProjectIdsOldestFirst(orgId).length < 3) {
        const suffix = `${Date.now().toString(36)}${created.length}`.slice(-8).toUpperCase();
        const res = await api.post("/api/projects", {
          data: { name: `E2E Billing UI Locked ${suffix}`, key: `BILL${suffix}` },
          failOnStatusCode: false,
        });
        expect(res.ok()).toBeTruthy();
        created.push((await res.json()).id);
      }

      try {
        const locked = activeProjectIdsOldestFirst(orgId)[2];
        setGraceWindow(orgId, -1);

        // The lock restricts writes only. If a downgrade could hide a project, "your data is safe"
        // would be untrue — a customer has to be able to open and export everything.
        await page.goto(`/projects/${locked}/testcases`);
        await expect(page.getByText(/Failed to load|not found/i)).toHaveCount(0);
        await expect(page).toHaveURL(new RegExp(`/projects/${locked}/testcases`));
      } finally {
        setProPlan(orgId);
        for (const id of created) await api.delete(`/api/projects/${id}`, { failOnStatusCode: false });
      }
    });
  });
});
