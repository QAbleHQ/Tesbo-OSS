#!/bin/bash
cd /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e
echo '=== e2e run 20260819-081507 — workers=10 ==='
echo 'specs: api/projects.spec.ts api/activity.spec.ts api/testcases.spec.ts api/zyra.spec.ts api/zyra-chat-consistency.spec.ts api/onboarding.spec.ts api/workspaces.spec.ts api/transport.spec.ts api/knowledge-base.spec.ts ui/projects-list.spec.ts ui/account.spec.ts ui/testcases-repository.spec.ts'
echo 'log:   /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e/.run-logs/20260819-081507.log'
echo
API_BASE_URL=http://localhost:1021 WEB_BASE_URL=http://localhost:1020 npx playwright test api/projects.spec.ts api/activity.spec.ts api/testcases.spec.ts api/zyra.spec.ts api/zyra-chat-consistency.spec.ts api/onboarding.spec.ts api/workspaces.spec.ts api/transport.spec.ts api/knowledge-base.spec.ts ui/projects-list.spec.ts ui/account.spec.ts ui/testcases-repository.spec.ts --workers=10 2>&1 | tee /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e/.run-logs/20260819-081507.log
echo
echo '=== run finished — exit $? ==='
