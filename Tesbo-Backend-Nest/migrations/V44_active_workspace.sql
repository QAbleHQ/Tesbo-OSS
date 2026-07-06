-- Track which organization is currently "active" for a user, enabling
-- multi-workspace membership with an explicit switch instead of always
-- resolving to the earliest-joined organization.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS active_organization_id UUID REFERENCES organizations(id);

-- Back-fill existing users to their earliest organization membership so
-- behavior is unchanged until they explicitly switch or join another org.
UPDATE users u SET active_organization_id = (
  SELECT o.id FROM organizations o
  JOIN organization_members om ON om.organization_id = o.id
  WHERE om.user_id = u.id
  ORDER BY o.created_at ASC LIMIT 1
)
WHERE u.active_organization_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_active_organization_id ON users(active_organization_id);
