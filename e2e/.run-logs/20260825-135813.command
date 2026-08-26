#!/bin/bash
cd /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e
echo '=== e2e run 20260825-135813 — workers=10 ==='
echo 'specs: regression/api/ api/suites.spec.ts api/cycles.spec.ts api/bugs.spec.ts api/signup.spec.ts'
echo 'log:   /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e/.run-logs/20260825-135813.log'
echo
API_BASE_URL=http://localhost:1021 WEB_BASE_URL=http://localhost:1020 npx playwright test regression/api/ api/suites.spec.ts api/cycles.spec.ts api/bugs.spec.ts api/signup.spec.ts --workers=10 2>&1 | tee /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e/.run-logs/20260825-135813.log
echo
echo '=== run finished — exit $? ==='
