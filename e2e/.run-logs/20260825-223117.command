#!/bin/bash
cd /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e
echo '=== e2e run 20260825-223117 — workers=10 ==='
echo 'specs: api/cycles.spec.ts api/bugs.spec.ts api/executions.spec.ts api/plans.spec.ts api/attachments.spec.ts ui/bugs.spec.ts ui/executions.spec.ts ui/project-dashboard.spec.ts ui/plans.spec.ts'
echo 'log:   /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e/.run-logs/20260825-223117.log'
echo
API_BASE_URL=http://localhost:1021 WEB_BASE_URL=http://localhost:1020 npx playwright test api/cycles.spec.ts api/bugs.spec.ts api/executions.spec.ts api/plans.spec.ts api/attachments.spec.ts ui/bugs.spec.ts ui/executions.spec.ts ui/project-dashboard.spec.ts ui/plans.spec.ts --workers=10 2>&1 | tee /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e/.run-logs/20260825-223117.log
echo
echo '=== run finished — exit $? ==='
