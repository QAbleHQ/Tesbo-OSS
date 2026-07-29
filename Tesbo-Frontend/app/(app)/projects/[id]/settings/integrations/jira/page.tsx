"use client";

import { ProjectIntegrationMapping } from "@/components/integrations/ProjectIntegrationMapping";
import { JiraProjectSettings } from "@/components/integrations/JiraProjectSettings";
import { getJiraStatus, listJiraProjects, connectJiraProjects } from "@/lib/api";

export default function JiraProjectIntegrationPage() {
  return (
    <ProjectIntegrationMapping
      provider="jira"
      label="Jira"
      remoteUnitLabel="Jira project"
      workspaceConfigHref="/settings/integrations/jira"
      fetchStatus={getJiraStatus}
      fetchRemoteList={listJiraProjects}
      saveMapping={connectJiraProjects}
      settingsPanel={<JiraProjectSettings />}
    />
  );
}
