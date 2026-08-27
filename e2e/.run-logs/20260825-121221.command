#!/bin/bash
cd /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e
echo '=== e2e run 20260825-121221 — workers=10 ==='
echo 'specs: api/rbac.spec.ts api/onboarding.spec.ts api/signup.spec.ts api/billing.spec.ts ui/theme.spec.ts'
echo 'log:   /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e/.run-logs/20260825-121221.log'
echo
API_BASE_URL=http://localhost:1021 WEB_BASE_URL=http://localhost:1020 npx playwright test api/rbac.spec.ts api/onboarding.spec.ts api/signup.spec.ts api/billing.spec.ts ui/theme.spec.ts --workers=10 2>&1 | tee /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e/.run-logs/20260825-121221.log
echo
echo '=== run finished — exit $? ==='
