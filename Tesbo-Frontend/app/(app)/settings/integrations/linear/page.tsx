"use client";

import { WorkspaceIntegrationConfig } from "@/components/integrations/WorkspaceIntegrationConfig";

export default function LinearWorkspaceIntegrationPage() {
  return (
    <WorkspaceIntegrationConfig
      provider="linear"
      label="Linear"
      consoleName="Linear API settings (Workspace Settings → API → OAuth Applications)"
    />
  );
}
