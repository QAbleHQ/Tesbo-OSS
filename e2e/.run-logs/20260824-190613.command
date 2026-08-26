#!/bin/bash
cd /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e
echo '=== e2e run 20260824-190613 — workers=10 ==='
echo 'specs: api/attachments.spec.ts api/reports.spec.ts api/bugs.spec.ts api/cycles.spec.ts api/executions.spec.ts api/zyra.spec.ts ui/project-dashboard.spec.ts ui/bugs.spec.ts ui/reports.spec.ts ui/plans.spec.ts ui/zyra.spec.ts'
echo 'log:   /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e/.run-logs/20260824-190613.log'
echo
API_BASE_URL=http://localhost:1021 WEB_BASE_URL=http://localhost:1020 npx playwright test api/attachments.spec.ts api/reports.spec.ts api/bugs.spec.ts api/cycles.spec.ts api/executions.spec.ts api/zyra.spec.ts ui/project-dashboard.spec.ts ui/bugs.spec.ts ui/reports.spec.ts ui/plans.spec.ts ui/zyra.spec.ts --workers=10 2>&1 | tee /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e/.run-logs/20260824-190613.log
echo
echo '=== run finished — exit $? ==='
