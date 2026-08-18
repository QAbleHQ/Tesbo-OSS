-- Admin-granted plans: lets a Tesbo operator put a workspace on Pro (or back on Launch) from the
-- internal admin panel, without a Stripe subscription existing. Used for comped accounts, design
-- partners, POCs, and winning back a churned customer.
--
-- The plan itself still lives in organizations.plan — entitlement is derived from that column plus
-- plan_grace_ends_at (see PlanLimitsService.getEntitlement), so an override is genuinely just a
-- write to plan. What these columns add is *provenance*: who changed it, when, why, and — the part
-- that matters for correctness — that Stripe is no longer the authority for this row.
--
-- Without plan_source, BillingService.reconcileDriftedPlan would undo every grant made to a
-- previously-subscribed workspace: it treats `plan = 'pro' AND stripe_subscription_id IS NOT NULL`
-- as drift, retrieves the (cancelled) subscription, and downgrades the workspace back to Launch,
-- emailing the owner as it goes. A churned customer given Pro by hand is exactly the common case,
-- and the id of their old subscription outlives the subscription itself.

ALTER TABLE organizations
    -- Which system decides this workspace's plan. 'stripe' is the normal path: webhooks and
    -- reconciliation own the plan column. 'admin' means an operator set it by hand and the Stripe
    -- code paths must leave it alone until the override is cleared, or until the workspace starts a
    -- real subscription (checkout writes plan_source back to 'stripe' — a paying customer always
    -- outranks a hand-set plan).
    ADD COLUMN plan_source VARCHAR(16) NOT NULL DEFAULT 'stripe'
        CHECK (plan_source IN ('stripe', 'admin')),

    -- Identifying the operator, not a foreign key. The admin panel keeps its own account store and
    -- authenticates independently of the product (a Tesbo user, even an owner, cannot sign into it),
    -- so there is no users.id to reference here. The same reason audit_logs.actor_id is left NULL on
    -- these rows: actor_id references actors, and a panel admin is not one.
    ADD COLUMN plan_override_by     VARCHAR(255),
    ADD COLUMN plan_override_at     TIMESTAMPTZ,
    ADD COLUMN plan_override_reason TEXT,

    -- Optional end date for a grant, so a 30-day comp or a POC does not quietly become permanent
    -- because nobody remembered to revoke it. NULL = until an operator changes it.
    --
    -- Enforced lazily on read rather than by a scheduled job, matching plan_grace_ends_at
    -- (V74_billing_lifecycle.sql): this app runs no cron, and a deadline comparison is exact at the
    -- moment it matters. PlanLimitsService.getEntitlement reverts the row the first time it sees an
    -- expired grant.
    ADD COLUMN plan_override_expires_at TIMESTAMPTZ;

-- Supports the expiry sweep and answers "which comps are running out?" without scanning every
-- workspace. Partial, because the overwhelming majority of rows never carry an override at all.
CREATE INDEX organizations_plan_override_expires_at_idx ON organizations (plan_override_expires_at)
    WHERE plan_override_expires_at IS NOT NULL;

CREATE INDEX organizations_plan_source_idx ON organizations (plan_source)
    WHERE plan_source = 'admin';
