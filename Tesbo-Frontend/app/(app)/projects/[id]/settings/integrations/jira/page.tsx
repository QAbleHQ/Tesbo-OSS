"use client";

import { ProjectIntegrationMapping } from "@/components/integrations/ProjectIntegrationMapping";
import { getJiraStatus, listJiraProjects, connectJiraProjects, syncJiraTickets } from "@/lib/api";

export default function JiraProjectIntegrationPage() {
  return (
    <ProjectIntegrationMapping
      label="Jira"
      remoteUnitLabel="Jira project"
      workspaceConfigHref="/settings/integrations/jira"
      fetchStatus={getJiraStatus}
      fetchRemoteList={listJiraProjects}
      saveMapping={connectJiraProjects}
      sync={syncJiraTickets}
    />
  );
}
