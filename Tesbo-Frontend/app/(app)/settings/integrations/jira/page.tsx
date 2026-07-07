"use client";

import { WorkspaceIntegrationConfig } from "@/components/integrations/WorkspaceIntegrationConfig";

export default function JiraWorkspaceIntegrationPage() {
  return (
    <WorkspaceIntegrationConfig
      provider="jira"
      label="Jira"
      consoleName="Atlassian Developer Console"
      consoleSteps={["Create an OAuth 2.0 integration.", "Add this callback URL under Authorization callback URLs."]}
      scopes={["read:jira-work", "read:jira-user", "write:jira-work", "offline_access"]}
    />
  );
}
