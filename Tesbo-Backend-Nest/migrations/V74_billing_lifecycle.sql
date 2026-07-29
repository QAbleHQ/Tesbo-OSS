-- Billing lifecycle hardening: currency lock-in, the post-downgrade grace period, and
-- storage-warning bookkeeping. All three hang off organizations because Tesbo Cloud bills
-- per workspace (see V70_billing_plan.sql).

-- Stripe permanently fixes a Customer's currency on its first invoice: once set, every later
-- subscription for that customer MUST use it. Mirroring it here means checkout can pin the
-- currency (and the pricing UI can lock its India toggle) without an extra Stripe round trip
-- on every page load. NULL = nothing charged yet, so the currency is still open.
ALTER TABLE organizations
    ADD COLUMN billing_currency VARCHAR(3) CHECK (billing_currency IN ('usd', 'inr'));

-- When a Pro subscription ends (non-payment or cancellation) the workspace drops to the
-- 'launch' plan immediately for billing purposes, but keeps Pro-sized limits until this
-- deadline so nobody is locked out of data they were using. Past it, Launch limits are
-- enforced for real (see PlanLimitsService). NULL = no grace window owed.
ALTER TABLE organizations
    ADD COLUMN plan_grace_ends_at TIMESTAMPTZ;

-- Set when a subscription invoice fails, cleared when one succeeds. Drives the "update your
-- card" banner and stops the failure email firing again on every Stripe retry.
ALTER TABLE organizations
    ADD COLUMN payment_failed_at TIMESTAMPTZ;

-- Highest storage threshold (as a percentage: 80, 95, 100) the workspace has already been
-- emailed about. Prevents a warning on every single upload once the workspace is near its cap,
-- and resets downward when usage drops so a later refill warns again.
ALTER TABLE organizations
    ADD COLUMN storage_warned_pct SMALLINT;

-- Set the first time Launch limits are actually enforced after the grace window closed, so the
-- "your workspace is now limited" email goes out exactly once. Checked lazily on the enforcement
-- path rather than by a scheduler — this app runs no cron, and notifying a workspace at the
-- moment it next does something is at least as useful as notifying it at midnight.
ALTER TABLE organizations
    ADD COLUMN grace_locked_notified_at TIMESTAMPTZ;

-- Backfills the currency for any workspace already subscribed before this migration: the
-- interval columns tell us they're on Pro, but not which currency, so leave those NULL and let
-- the next reconcile/webhook fill it in from Stripe rather than guessing wrong here.

CREATE INDEX organizations_plan_grace_ends_at_idx ON organizations (plan_grace_ends_at)
    WHERE plan_grace_ends_at IS NOT NULL;
