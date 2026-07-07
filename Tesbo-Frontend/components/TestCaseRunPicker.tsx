"use client";

import { useEffect, useState } from "react";
import { listTestRuns, listCycleExecutions, type TestRunListItem, type ExecutionItem } from "@/lib/api";
import { Button, Select } from "@/components/ui";

export interface LinkRow {
  cycleId: string;
  cycleName: string;
  testcaseId: string;
  testcaseTitle: string;
  executionId?: string;
}

interface Props {
  projectId: string;
  value: LinkRow[];
  onChange: (rows: LinkRow[]) => void;
}

export default function TestCaseRunPicker({ projectId, value, onChange }: Props) {
  const [runs, setRuns] = useState<TestRunListItem[]>([]);
  const [pickerRunId, setPickerRunId] = useState("");
  const [pickerExecutions, setPickerExecutions] = useState<ExecutionItem[]>([]);
  const [pickerExecutionId, setPickerExecutionId] = useState("");
  const [loadingExecutions, setLoadingExecutions] = useState(false);

  useEffect(() => {
    listTestRuns(projectId).then(setRuns).catch(() => setRuns([]));
  }, [projectId]);

  useEffect(() => {
    if (!pickerRunId) {
      setPickerExecutions([]);
      setPickerExecutionId("");
      return;
    }
    setLoadingExecutions(true);
    listCycleExecutions(pickerRunId)
      .then((list) => setPickerExecutions(list))
      .catch(() => setPickerExecutions([]))
      .finally(() => setLoadingExecutions(false));
    setPickerExecutionId("");
  }, [pickerRunId]);

  function addLink() {
    const run = runs.find((r) => r.id === pickerRunId);
    const execution = pickerExecutions.find((e) => e.id === pickerExecutionId);
    if (!run || !execution) return;
    const alreadyLinked = value.some((link) => link.cycleId === run.id && link.testcaseId === execution.testcaseId);
    if (alreadyLinked) return;
    onChange([
      ...value,
      {
        cycleId: run.id,
        cycleName: run.name,
        testcaseId: execution.testcaseId,
        testcaseTitle: execution.snapshotTitle || execution.title,
        executionId: execution.id,
      },
    ]);
    setPickerRunId("");
    setPickerExecutionId("");
  }

  function removeLink(cycleId: string, testcaseId: string) {
    onChange(value.filter((link) => !(link.cycleId === cycleId && link.testcaseId === testcaseId)));
  }

  return (
    <div className="space-y-2">
      {value.length > 0 ? (
        <ul className="space-y-1">
          {value.map((link) => (
            <li
              key={`${link.cycleId}-${link.testcaseId}`}
              className="flex items-center justify-between rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-1.5 text-[13px]"
            >
              <span>
                <span className="font-medium text-[var(--foreground)]">{link.testcaseTitle}</span>
                <span className="text-[var(--muted)]"> — {link.cycleName}</span>
              </span>
              <button
                type="button"
                onClick={() => removeLink(link.cycleId, link.testcaseId)}
                className="text-[var(--muted)] hover:text-[var(--error)]"
                aria-label="Remove link"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-[var(--muted)]">No test case or run linked yet.</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Select value={pickerRunId} onChange={(e) => setPickerRunId(e.target.value)} className="max-w-[200px]">
          <option value="">Test run…</option>
          {runs.map((run) => (
            <option key={run.id} value={run.id}>{run.name}</option>
          ))}
        </Select>
        <Select
          value={pickerExecutionId}
          onChange={(e) => setPickerExecutionId(e.target.value)}
          disabled={!pickerRunId || loadingExecutions}
          className="max-w-[240px]"
        >
          <option value="">{loadingExecutions ? "Loading…" : "Test case…"}</option>
          {pickerExecutions.map((execution) => (
            <option key={execution.id} value={execution.id}>
              {execution.externalId ? `${execution.externalId} — ` : ""}
              {execution.snapshotTitle || execution.title}
            </option>
          ))}
        </Select>
        <Button type="button" variant="secondary" size="sm" onClick={addLink} disabled={!pickerRunId || !pickerExecutionId}>
          + Add link
        </Button>
      </div>
    </div>
  );
}
