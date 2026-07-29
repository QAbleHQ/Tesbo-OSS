"use client";

import { ProjectIntegrationMapping } from "@/components/integrations/ProjectIntegrationMapping";
import { getLinearStatus, listLinearTeams, connectLinearTeams } from "@/lib/api";

export default function LinearProjectIntegrationPage() {
  return (
    <ProjectIntegrationMapping
      provider="linear"
      label="Linear"
      remoteUnitLabel="Linear team"
      workspaceConfigHref="/settings/integrations/linear"
      fetchStatus={getLinearStatus}
      fetchRemoteList={listLinearTeams}
      saveMapping={connectLinearTeams}
    />
  );
}
