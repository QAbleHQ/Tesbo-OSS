"use client";

import { ProjectIntegrationMapping } from "@/components/integrations/ProjectIntegrationMapping";
import { getLinearStatus, listLinearTeams, connectLinearTeams, syncLinearTickets } from "@/lib/api";

export default function LinearProjectIntegrationPage() {
  return (
    <ProjectIntegrationMapping
      label="Linear"
      remoteUnitLabel="Linear team"
      workspaceConfigHref="/settings/integrations/linear"
      fetchStatus={getLinearStatus}
      fetchRemoteList={listLinearTeams}
      saveMapping={connectLinearTeams}
      sync={syncLinearTickets}
    />
  );
}
