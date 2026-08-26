#!/bin/bash
cd /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e
echo '=== e2e run 20260825-155048 — workers=10 ==='
echo 'specs: --project=ui'
echo 'log:   /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e/.run-logs/20260825-155048.log'
echo
API_BASE_URL=http://localhost:1021 WEB_BASE_URL=http://localhost:1020 npx playwright test --project=ui --workers=10 2>&1 | tee /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e/.run-logs/20260825-155048.log
echo
echo '=== run finished — exit $? ==='
