"use client";

import { Button, Field, FieldLabel, Input } from "@/components/ui";

export type SelfLoggedSystem = "JIRA" | "LINEAR" | "OTHER";

interface Props {
  jiraConnected: boolean;
  linearConnected: boolean;
  system: SelfLoggedSystem;
  onSystemChange: (s: SelfLoggedSystem) => void;
  url: string;
  onUrlChange: (v: string) => void;
}

// No search here on purpose — the ticket already lives in the user's own tracker, we're just
// recording where to find it. Ticket search only applies when linking to an already-filed issue.
export default function SelfLoggedTrackerField({ jiraConnected, linearConnected, system, onSystemChange, url, onUrlChange }: Props) {
  return (
    <Field>
      <FieldLabel>Which system?</FieldLabel>
      <div className="flex flex-wrap gap-2">
        {jiraConnected && (
          <Button type="button" size="sm" variant={system === "JIRA" ? "primary" : "secondary"} onClick={() => onSystemChange("JIRA")}>
            Jira
          </Button>
        )}
        {linearConnected && (
          <Button type="button" size="sm" variant={system === "LINEAR" ? "primary" : "secondary"} onClick={() => onSystemChange("LINEAR")}>
            Linear
          </Button>
        )}
        <Button type="button" size="sm" variant={system === "OTHER" ? "primary" : "secondary"} onClick={() => onSystemChange("OTHER")}>
          Other
        </Button>
      </div>
      <Input type="url" className="mt-2" value={url} onChange={(e) => onUrlChange(e.target.value)} placeholder="https://example.com/browse/BUG-123" />
    </Field>
  );
}
