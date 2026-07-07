"use client";

import { WorkspaceIntegrationConfig } from "@/components/integrations/WorkspaceIntegrationConfig";

export default function LinearWorkspaceIntegrationPage() {
  return (
    <WorkspaceIntegrationConfig
      provider="linear"
      label="Linear"
      consoleName="Linear API settings (Workspace Settings → API → OAuth Applications)"
      consoleSteps={["Create a new OAuth application.", "Add this callback URL under Redirect URIs."]}
      scopes={["read", "write", "issues:create", "comments:create"]}
    />
  );
}
