// Text helpers shared by LegacyService and the integration-sync module. They live here rather
// than in legacy.service.ts because LegacyService imports IntegrationSyncService (to enqueue a
// run), so anything the sync processors also need would otherwise close an import cycle.

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Flattens Atlassian Document Format (the shape Jira returns for descriptions and comment
// bodies) down to plain text. ADF is a recursive {type, content[], text} tree; we only care
// about the leaf text and enough structure to keep paragraphs on separate lines.
export function jiraDescriptionToText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(jiraDescriptionToText).filter(Boolean).join("\n");
  if (typeof value !== "object") return String(value);

  const node = value as Record<string, any>;
  const parts: string[] = [];
  if (typeof node.text === "string") parts.push(node.text);
  if (Array.isArray(node.content)) parts.push(jiraDescriptionToText(node.content));
  return parts.filter(Boolean).join(node.type === "paragraph" ? "\n" : " ");
}
