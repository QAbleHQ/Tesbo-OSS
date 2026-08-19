# Tesbo E2E Coverage and Quality Report

Snapshot: August 19, 2026  
Audience: Product, engineering, and QA stakeholders

## Executive Summary

- **Coverage breadth is high but not complete.** The current suite references 250 of 254 API method-and-path routes (98%), 199 of 203 distinct API paths (98%), and all 50 in-scope UI pages (100%). Four API routes remain uncovered.
- **The suite contains 1,099 Playwright tests in 58 files:** 721 API tests in 36 files and 378 UI tests in 22 files. API tests are 65.6% of the suite and UI tests are 34.4%.
- **The suite can materially stabilize Tesbo, but it is not currently a reliable release gate.** It has already exposed serious authorization, tenant-isolation, data-integrity, upload-crash, and workflow defects. However, route/page coverage measures whether a surface is touched, not whether every important behavior is tested. Depth is still unmeasured, several tests are environment-gated, the last recorded full run failed, and the coverage gate is not yet documented as enforced in CI.
- **Immediate priorities are clear:** cover password recovery and project overview, restore a trustworthy green baseline, add UI depth for attachments and reports, measure happy-path/validation/401/cross-tenant depth, and make a small critical smoke subset mandatory in CI.

## Current Coverage

| Measure | Covered / total | Coverage | Interpretation |
|---|---:|---:|---|
| API routes (method + path) | 250 / 254 | 98% | Best API breadth measure; four verb-specific routes are missing |
| Distinct API paths | 199 / 203 | 98% | URL-level breadth; does not distinguish HTTP methods |
| In-scope UI pages | 50 / 50 | 100% | Every counted page is visited by at least one asserting spec |
| API tests | 721 in 36 files | 65.6% of tests | Strong backend/API emphasis |
| UI tests | 378 in 22 files | 34.4% of tests | Broad page reach, uneven workflow depth |
| Total | 1,099 in 58 files | — | Static Playwright discovery count |

The coverage denominator excludes deliberately out-of-scope static/legal and integration callback screens as defined by the repository's coverage tool. These figures are structural coverage, not code, branch, requirement, risk, or mutation coverage.

## Where Tests Are Lacking

### P0 — restore release confidence

1. **Get the full suite green and classify every failure.** The latest saved Playwright result is `failed` with 119 failed test IDs. Logs show a mixture of product assertions, fixture/login provisioning failures, timeouts, browser shutdown noise, and environment-sensitive behavior. Until a clean run is produced against a known build, coverage cannot be converted into a release recommendation.
2. **Create a mandatory critical smoke gate.** Authentication, workspace/project access, core test-case lifecycle, run/execution lifecycle, billing entitlement, and tenant-isolation checks should run on every pull request or deployment with deterministic seed data.
3. **Prevent silent skips.** Many suites call `test.skip` when Docker logs, PostgreSQL control, billing configuration, webhook support, or provisioned tenants are unavailable. CI should report skip counts by reason and fail when a required critical test is skipped.

### P1 — close current functional gaps

1. **Password recovery API (critical):**
   - `POST /api/auth/password/forgot`
   - `GET /api/auth/password/reset/:token`
   - `POST /api/auth/password/reset`

   The UI account suite exercises the user journey, but these routes have no direct API assertions in the current route audit. Add enumeration resistance, invalid/expired/replayed token, password policy, session invalidation, rate limiting, and email/log delivery assertions.

2. **Projects overview API (high):**
   - `GET /api/projects/overview`

   This endpoint feeds the projects list and aggregates data across projects. Add authentication, workspace/project filtering, archived-project behavior, partial downstream failure, empty state, data accuracy, and performance-bound tests.

3. **Repair coverage-tool/spec drift (high):** 15 referenced paths do not match any declared route. At least one is a deleted import-preview route. Remove stale calls and comments, then refine the resolver for benign builder false positives. A passing test against a nonexistent route can validate the wrong behavior.

### P2 — improve depth where breadth is misleading

1. **Attachments UI:** API coverage is deep, but upload, download, delete, quota-warning, and failure recovery need browser-level coverage.
2. **Reports/analytics UI:** the tracker names a reports UI tenant, but there is no dedicated `ui/reports.spec.ts`. Add filters, aggregation accuracy, empty/loading/error states, chart/table consistency, export, and role visibility.
3. **Cross-cutting depth:** score each route or critical capability on happy path, validation/boundary, unauthenticated access, and cross-tenant authorization. The repository target is 4/4, but this is currently not measured.
4. **External integrations and AI:** successful live/fake upstream response handling remains thinner than authorization and “not configured” behavior. Add controlled fake upstreams, retry/timeout/error mapping, idempotency, secret redaction, and callback-state validation.
5. **Nonfunctional risks:** add explicit concurrency/idempotency, accessibility beyond theme/contrast, browser/device compatibility, resilience, large-data performance, migration/upgrade, backup/restore, and observability checks. These are not represented by the 98–100% surface counters.

## Test Quality Assessment

| Dimension | Rating | Evidence and implication |
|---|---|---|
| Functional breadth | Strong | 98% API-route and 100% in-scope page coverage |
| Security/tenant isolation | Strong | Dedicated authorization, RBAC, project-access, invitation, and cross-tenant scenarios; prior tests found severe missing-access-control defects |
| Business workflow realism | Strong | CRUD lifecycles, billing/webhooks, imports, executions, KB, integrations, Zyra, and a full scenario are represented |
| Negative/boundary testing | Good | Many malformed-ID, validation, pagination, quota, replay, rate-limit, and failure-mode assertions |
| UI depth | Moderate | 378 tests and all pages visited, but several pages are only smoke-opened and attachments/reports remain thin |
| Determinism/portability | Weak to moderate | Tests depend on Docker logs, direct PostgreSQL access, external-service configuration, shared rate limits, and persistent seeded state; conditional skips are common |
| Maintainability | Moderate | Reusable fixtures and an auditable coverage script are positives; 15 dangling route references, stale documentation, strict-locator defects, and state coupling create maintenance risk |
| Coverage validity | Moderate | The counter is auditable and useful, but measures references rather than executed assertions, branches, or requirements; it has previously needed multiple resolver corrections |
| Release-gate readiness | Weak today | Latest saved run is failed; a current clean run could not be performed because Docker access is unavailable; CI enforcement is not established by the inspected E2E package |

**Overall quality: B- for test design, C for current operational reliability.** The tests are substantially better than a superficial smoke suite and have demonstrated defect-finding power. Their present execution reliability and unmeasured depth prevent an A rating or an unconditional release sign-off.

## Criticality and Priority Model

| Criticality | Capabilities | Required minimum behavior |
|---|---|---|
| Critical / P0 | Login/signup/password recovery, tenant isolation/RBAC, project and test-case core lifecycle, execution results, billing entitlement/webhook integrity, public-share authorization, uploads that can affect service availability | Happy path, validation, 401/403, cross-tenant, destructive/idempotent behavior; must be deterministic and cannot silently skip |
| High / P1 | Members/invitations, import/export, KB, reports/analytics, API keys, integrations, project overview, Zyra-generated test persistence | Main workflows, permission matrix, malformed/empty/large inputs, upstream failure, retry/idempotency, auditability |
| Medium / P2 | Navigation, settings, theme, activity/notifications, pagination/filter/sort, secondary CRUD | Representative browsers, error/empty/loading states, persistence and accessibility |
| Low / P3 | Static presentation, cosmetic variants, low-risk informational views | Visual/accessibility checks or targeted smoke coverage |

Existing tests should be tagged with this priority and with capability ownership. Test count alone should never determine criticality; a single tenant-isolation or billing test can protect more product risk than dozens of cosmetic assertions.

## Does This Suite Stabilize the Product?

**Yes, materially—but only as part of a disciplined release system.** The suite has already found and helped verify fixes for defects capable of exposing another tenant's data, allowing unauthorized mutations, crashing the API on malformed uploads, breaking initial workspace setup, and producing inconsistent billing or workflow state. That is direct stabilization value.

It does not yet prove the product is stable because:

- 98–100% breadth does not establish behavioral depth or branch coverage;
- the current four API gaps include a security-sensitive password-reset flow;
- many environment-dependent tests may skip;
- the latest recorded run is red and has not been triaged into a current release verdict;
- the suite is not shown to be a mandatory, consistently green CI gate;
- external dependency, concurrency, performance, browser, migration, and recovery risks remain lightly covered.

The appropriate current release statement is: **high-confidence regression asset, not yet a standalone release certificate.**

## Recommended 30-Day Plan

1. **Days 1–3:** Add direct API coverage for the four uncovered routes; remove the stale import-preview reference; make the coverage report and dangling-path audit pass.
2. **Week 1:** Run the suite against a clean, pinned build; classify the 119 saved failures as product, test, environment, or obsolete; fix the test/environment failures; publish a new baseline with pass/fail/skip counts and duration.
3. **Week 2:** Define and tag P0 smoke tests. Run them on every pull request and the full suite post-deploy/nightly. Fail CI on any P0 skip, failure, or coverage regression.
4. **Weeks 2–3:** Add attachments UI and reports UI suites; complete password-reset abuse cases and project-overview accuracy/isolation cases.
5. **Weeks 3–4:** Implement a depth matrix for critical routes (happy path, validation, 401, cross-tenant), then add concurrency/idempotency and fake-upstream tests for billing, integrations, and AI.
6. **Ongoing:** Track pass rate, flaky-test rate, skip rate, median/p95 duration, escaped defects by capability, and time-to-diagnosis. Quarantine only with an owner and expiry date.

## Caveats and Assumptions

- Counts were measured statically on August 19, 2026 with `e2e/scripts/coverage-report.ts` and Playwright `--list`; no product services are required for these counts.
- A fresh execution was not possible in this audit because access to the local Docker daemon was denied. The latest saved run is evidence of a failed run, not a diagnosis that all 119 entries are current product defects.
- The working tree contains pre-existing user changes. This audit did not alter application or test code.
- The historical tracker was last formally verified on August 14 and reports earlier totals. Current code is authoritative for the numbers in this report.

## Evidence Used

- `e2e/scripts/coverage-report.ts` and its current output
- Playwright discovery through `npx playwright test --list --project=api` and `--project=ui`
- `e2e/playwright.config.ts` and `e2e/package.json`
- `docs/e2e-coverage-waves.md`
- Current E2E specifications under `e2e/api` and `e2e/ui`
- `e2e/test-results/.last-run.json` and recent logs under `e2e/.run-logs`

