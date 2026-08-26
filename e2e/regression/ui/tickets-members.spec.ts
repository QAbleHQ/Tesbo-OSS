import { expect, test } from "@playwright/test";
import { ticket } from "../fixtures";

/*
 * Reported-ticket regression for Workspace Settings → Members.
 * Card 10230843780, BetterBugs 6a7dc0f5.
 *
 * The card asks for two things: a recognisable Delete/Remove icon, and a confirmation dialog before
 * a member is actually removed. Neither exists on any branch — MembersTab.tsx wires the control
 * straight to `onClick={() => handleRemoveMember(m.userId)}`, which calls removeWorkspaceMember()
 * and toasts "Team member removed". So the confirmation test is expected-red.
 *
 * WHY THIS FOLDER CAN ONLY GO SO FAR. The remove control renders only when
 * `myRole === "owner" && !isSelf && !isOwner`, so it needs a second, non-owner member to exist. This
 * suite provisions extra users by writing them into Postgres (utils/rbac-tenant.ts) because an invite
 * token never leaves the server except by email — and this folder deliberately holds no database
 * access, so it cannot create one. Rather than invent a member in account A's shared workspace (which
 * ui/members.spec.ts and api/rbac.spec.ts both make assertions about), these tests use a member if
 * the environment already has one and skip with a stated reason if it does not.
 *
 * That is a real limitation and worth saying plainly: on a workspace with only an owner, this card's
 * regression does not run. ui/members.spec.ts covers the same screen WITH a seeded roster whenever a
 * database URL is configured.
 */

test.describe("workspace members — reported tickets", () => {
  test(
    ticket("REG-MEM-01", "10230843780", "removing a member asks for confirmation first"),
    async ({ page }) => {
      // EXPECTED RED: there is no dialog, the removal happens on the first click.
      test.fail();

      await page.goto("/settings?tab=members");

      const remove = page.getByRole("button", { name: /Remove from team/i });
      const removable = await remove.count();
      test.skip(
        removable === 0,
        "this workspace has no removable member (owner-only), so the remove control is not rendered — " +
          "see the file header for why this folder cannot seed one",
      );

      /*
       * The removal request is intercepted and aborted so that a missing confirmation cannot actually
       * delete somebody's membership from a shared workspace while proving the point. Counting the
       * calls is also the assertion with teeth: a confirmation dialog means zero requests until it is
       * confirmed.
       */
      let removeCalls = 0;
      await page.route(
        (url) => /\/api\/workspace\/members\//.test(url.pathname),
        (route) => {
          if (route.request().method() !== "DELETE") return route.continue();
          removeCalls += 1;
          return route.abort("failed");
        },
      );

      await remove.first().click();

      // getByRole("dialog") would find nothing even once a dialog exists — Modal.tsx uses
      // role="presentation". Matched on content instead, so this passes the moment a real
      // confirmation appears however it is built.
      const confirmation = page.locator('div[role="presentation"], [role="dialog"], [role="alertdialog"]').last();
      await expect(confirmation).toBeVisible();
      await expect(confirmation.getByRole("button", { name: /^(Yes|Confirm|Remove|Delete)$/i })).toBeVisible();
      await expect(confirmation.getByRole("button", { name: /^(No|Cancel)$/i })).toBeVisible();
      expect(removeCalls, "clicking remove must not delete the membership before it is confirmed").toBe(0);
    },
  );

  test(
    ticket("REG-MEM-02", "10230843780", "the remove control is labelled so its purpose is unambiguous"),
    async ({ page }) => {
      /*
       * The icon half of the card, asserted as a label rather than as a picture.
       *
       * "Incorrect Delete Icon" is a visual judgement — MembersTab.tsx uses IconUserMinus where the
       * reporter expected a bin — and a screenshot comparison would be brittle and would not say what
       * was wrong. What is objectively checkable, and what actually determines whether a user knows
       * what the button does, is that it carries an accessible name saying so. That part is GREEN
       * today (`title="Remove from team"`), so this pins it against a redesign that swaps the glyph
       * and drops the label with it. Which glyph to use stays a design decision.
       */
      await page.goto("/settings?tab=members");

      const remove = page.getByRole("button", { name: /Remove from team/i });
      test.skip(
        (await remove.count()) === 0,
        "this workspace has no removable member (owner-only), so the remove control is not rendered",
      );

      await expect(remove.first()).toBeVisible();
    },
  );
});
