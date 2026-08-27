#!/bin/bash
cd /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e
echo '=== e2e run 20260825-140613 — workers=10 ==='
echo 'specs: regression/ui/tickets-app-shell.spec.ts regression/ui/tickets-account.spec.ts regression/ui/tickets-auth-forms.spec.ts regression/ui/tickets-members.spec.ts regression/ui/tickets-project-settings.spec.ts regression/ui/tickets-zyra.spec.ts'
echo 'log:   /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e/.run-logs/20260825-140613.log'
echo
API_BASE_URL=http://localhost:1021 WEB_BASE_URL=http://localhost:1020 npx playwright test regression/ui/tickets-app-shell.spec.ts regression/ui/tickets-account.spec.ts regression/ui/tickets-auth-forms.spec.ts regression/ui/tickets-members.spec.ts regression/ui/tickets-project-settings.spec.ts regression/ui/tickets-zyra.spec.ts --workers=10 2>&1 | tee /Users/apple/Tesbo/Tesbo-Test-Manager-Private/e2e/.run-logs/20260825-140613.log
echo
echo '=== run finished — exit $? ==='
