-- Declared country for a workspace, captured at onboarding and editable in workspace settings.
--
-- Used as a SOFT signal in the India-pricing decision: it's self-reported, so it can never outrank
-- IP or edge-header detection (see CountryDetectionService for the precedence). It only decides the
-- outcome when those produce nothing at all — which is what stops a real Indian customer silently
-- being quoted USD during an IP-lookup outage.
ALTER TABLE organizations
    ADD COLUMN country VARCHAR(2) CHECK (country ~ '^[A-Z]{2}$');

-- The country most recently resolved from the request itself (edge header or IP lookup), recorded so
-- a declared/detected disagreement is queryable after the fact — e.g. a workspace claiming IN whose
-- traffic consistently comes from elsewhere.
ALTER TABLE organizations
    ADD COLUMN last_detected_country VARCHAR(2) CHECK (last_detected_country ~ '^[A-Z]{2}$');

ALTER TABLE organizations
    ADD COLUMN last_detected_country_at TIMESTAMPTZ;

-- Finds workspaces whose self-reported country disagrees with where their traffic actually comes
-- from. Partial index because the mismatch set is expected to be tiny next to the whole table.
CREATE INDEX organizations_country_mismatch_idx ON organizations (country, last_detected_country)
    WHERE country IS NOT NULL AND last_detected_country IS NOT NULL AND country <> last_detected_country;
