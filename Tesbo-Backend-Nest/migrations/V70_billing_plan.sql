-- Tesbo Cloud billing: tracks which hosted plan a workspace (organization) is on and the
-- Stripe subscription backing it. Pricing is per workspace, not per seat, so this lives on
-- organizations rather than users. Every workspace starts on the free "launch" plan; the
-- billing module flips it to "pro" via the Stripe Checkout / webhook flow.
ALTER TABLE organizations
    ADD COLUMN plan                  VARCHAR(16) NOT NULL DEFAULT 'launch' CHECK (plan IN ('launch', 'pro')),
    ADD COLUMN billing_interval      VARCHAR(16) CHECK (billing_interval IN ('monthly', 'annual')),
    ADD COLUMN stripe_customer_id    VARCHAR(255),
    ADD COLUMN stripe_subscription_id VARCHAR(255),
    ADD COLUMN subscription_status   VARCHAR(32),
    ADD COLUMN current_period_end    TIMESTAMPTZ,
    ADD COLUMN cancel_at_period_end  BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX organizations_stripe_customer_id_idx ON organizations (stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL;

-- Stripe retries webhook deliveries (e.g. on a slow/failed response), so each event id is
-- recorded once processed and re-deliveries are skipped rather than applied twice.
CREATE TABLE stripe_webhook_events (
    id         VARCHAR(255) PRIMARY KEY,
    type       VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
