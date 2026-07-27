"use client";

import { WorkspaceIntegrationConfig } from "@/components/integrations/WorkspaceIntegrationConfig";

export default function JiraWorkspaceIntegrationPage() {
  return (
    <WorkspaceIntegrationConfig
      provider="jira"
      label="Jira"
      consoleName="Atlassian Developer Console"
    />
  );
}
