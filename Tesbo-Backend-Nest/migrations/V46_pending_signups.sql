-- Holds name + hashed password for a signup (self-serve or invite-based)
-- while its email is being verified via OTP. Nothing is written to `users`
-- until the code checks out, so an unverified email never gets an account.
CREATE TABLE pending_signups (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) NOT NULL,
    name            VARCHAR(255) NOT NULL,
    password_hash   VARCHAR(255),
    invitation_id   UUID REFERENCES invitations(id) ON DELETE CASCADE,
    expires_at      TIMESTAMPTZ NOT NULL,
    consumed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pending_signups_email ON pending_signups(email);
CREATE INDEX idx_pending_signups_invitation_id ON pending_signups(invitation_id);
