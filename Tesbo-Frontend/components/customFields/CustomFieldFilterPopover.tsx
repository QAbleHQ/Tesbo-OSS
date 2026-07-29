"use client";

import { useEffect, useRef, useState } from "react";
import { IconFilter } from "@tabler/icons-react";
import type { CustomFieldDefinition, CustomFieldFilterCondition, CustomFieldFilterOperator } from "@/lib/api";
import { Button, Select } from "@/components/ui";
import { FILTER_OPERATORS_BY_TYPE } from "./customFieldTypes";

export default function CustomFieldFilterPopover({
  definitions,
  conditions,
  onChange,
}: {
  definitions: CustomFieldDefinition[];
  conditions: CustomFieldFilterCondition[];
  onChange: (next: CustomFieldFilterCondition[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [definitionId, setDefinitionId] = useState("");
  const [operator, setOperator] = useState<CustomFieldFilterOperator | "">("");
  const [value, setValue] = useState("");
  const [valueTo, setValueTo] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (definitions.length === 0) return null;

  const selectedDefinition = definitions.find((d) => d.id === definitionId);
  const operatorOptions = selectedDefinition ? FILTER_OPERATORS_BY_TYPE[selectedDefinition.fieldType] : [];
  const selectedOperatorMeta = operatorOptions.find((o) => o.value === operator);

  function resetDraft() {
    setDefinitionId("");
    setOperator("");
    setValue("");
    setValueTo("");
  }

  function addCondition() {
    if (!selectedDefinition || !operator) return;
    const condition: CustomFieldFilterCondition = { definitionId: selectedDefinition.id, operator };
    if (selectedOperatorMeta?.needsValue) {
      if (selectedDefinition.fieldType === "number") condition.value = Number(value);
      else condition.value = value;
    }
    if (selectedOperatorMeta?.needsSecondValue) {
      condition.valueTo = selectedDefinition.fieldType === "number" ? Number(valueTo) : valueTo;
    }
    onChange([...conditions, condition]);
    resetDraft();
    setOpen(false);
  }

  function removeCondition(index: number) {
    onChange(conditions.filter((_, i) => i !== index));
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex h-[30px] items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2.5 text-[12px] text-[var(--ink-600)] hover:bg-[var(--surface-secondary)]"
      >
        <IconFilter size={13} stroke={1.75} />
        Custom fields
        {conditions.length > 0 && (
          <span className="ml-0.5 rounded-full bg-[var(--brand-primary)] px-1.5 text-[11px] font-medium text-white">{conditions.length}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+4px)] z-20 w-72 rounded-lg border border-[var(--border)] bg-[var(--surface-overlay)] p-3 shadow-[var(--shadow-elevated)]">
          <div className="space-y-2">
            <Select
              value={definitionId}
              onChange={(e) => {
                setDefinitionId(e.target.value);
                setOperator("");
                setValue("");
                setValueTo("");
              }}
              className="h-8 text-[12px]"
            >
              <option value="">Select a field…</option>
              {definitions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
            {selectedDefinition && (
              <Select value={operator} onChange={(e) => setOperator(e.target.value as CustomFieldFilterOperator)} className="h-8 text-[12px]">
                <option value="">Select an operator…</option>
                {operatorOptions.map((op) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </Select>
            )}
            {selectedDefinition && selectedOperatorMeta?.needsValue && (
              <ValueInput definition={selectedDefinition} value={value} onChange={setValue} />
            )}
            {selectedDefinition && selectedOperatorMeta?.needsSecondValue && (
              <ValueInput definition={selectedDefinition} value={valueTo} onChange={setValueTo} />
            )}
            <Button type="button" size="sm" fullWidth onClick={addCondition} disabled={!selectedDefinition || !operator}>
              Add filter
            </Button>
          </div>
          {conditions.length > 0 && (
            <div className="mt-3 space-y-1 border-t border-[var(--border)] pt-2">
              {conditions.map((condition, index) => {
                const def = definitions.find((d) => d.id === condition.definitionId);
                return (
                  <div key={index} className="flex items-center justify-between gap-2 text-[12px] text-[var(--muted)]">
                    <span className="truncate">
                      {def?.name || "Unknown field"} {condition.operator.replace(/_/g, " ")}
                      {condition.value != null ? ` "${condition.value}"` : ""}
                    </span>
                    <button type="button" onClick={() => removeCondition(index)} className="shrink-0 text-[var(--error)] hover:underline">
                      Remove
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ValueInput({
  definition,
  value,
  onChange,
}: {
  definition: CustomFieldDefinition;
  value: string;
  onChange: (value: string) => void;
}) {
  if (definition.fieldType === "date") {
    return (
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2 text-[12px] text-[var(--ink-600)] outline-none"
      />
    );
  }
  if (definition.fieldType === "number") {
    return (
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2 text-[12px] text-[var(--ink-600)] outline-none"
      />
    );
  }
  if (definition.fieldType === "single_select" || definition.fieldType === "multi_select") {
    const options = (definition.config.options || []).filter((o) => o.active);
    return (
      <Select value={value} onChange={(e) => onChange(e.target.value)} className="h-8 text-[12px]">
        <option value="">Select an option…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  }
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-full rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2 text-[12px] text-[var(--ink-600)] outline-none"
    />
  );
}
