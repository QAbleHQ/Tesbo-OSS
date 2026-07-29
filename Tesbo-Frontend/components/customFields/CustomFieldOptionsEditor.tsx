"use client";

import { useState } from "react";
import { IconChevronDown, IconChevronUp, IconPlus, IconTrash } from "@tabler/icons-react";
import { Button, Input } from "@/components/ui";

export interface DraftOption {
  /** Stable client-side key. Distinct from `id` so brand-new (unsaved) options can be
   * told apart from options that already exist on the server (which only support
   * deactivation, not removal, once saved). */
  localKey: string;
  id?: string;
  label: string;
  active: boolean;
}

let localKeySeq = 0;
export function nextLocalKey(): string {
  localKeySeq += 1;
  return `local-${localKeySeq}`;
}

export default function CustomFieldOptionsEditor({
  options,
  onChange,
  disabled,
}: {
  options: DraftOption[];
  onChange: (next: DraftOption[]) => void;
  disabled?: boolean;
}) {
  const [newLabel, setNewLabel] = useState("");

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= options.length) return;
    const next = [...options];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  function updateLabel(index: number, label: string) {
    const next = [...options];
    next[index] = { ...next[index], label };
    onChange(next);
  }

  function toggleActive(index: number) {
    const next = [...options];
    next[index] = { ...next[index], active: !next[index].active };
    onChange(next);
  }

  function removeNew(index: number) {
    onChange(options.filter((_, i) => i !== index));
  }

  function addOption() {
    const label = newLabel.trim();
    if (!label) return;
    if (options.some((o) => o.label.toLowerCase() === label.toLowerCase())) return;
    onChange([...options, { localKey: nextLocalKey(), label, active: true }]);
    setNewLabel("");
  }

  return (
    <div className="space-y-2">
      {options.length === 0 && <p className="text-[13px] text-[var(--muted)]">No options yet — add at least one below.</p>}
      {options.map((option, index) => (
        <div key={option.localKey} className="flex items-center gap-1.5">
          <div className="flex flex-col">
            <button
              type="button"
              onClick={() => move(index, -1)}
              disabled={disabled || index === 0}
              className="text-[var(--muted-soft)] hover:text-[var(--foreground)] disabled:opacity-30"
              aria-label="Move option up"
            >
              <IconChevronUp size={14} />
            </button>
            <button
              type="button"
              onClick={() => move(index, 1)}
              disabled={disabled || index === options.length - 1}
              className="text-[var(--muted-soft)] hover:text-[var(--foreground)] disabled:opacity-30"
              aria-label="Move option down"
            >
              <IconChevronDown size={14} />
            </button>
          </div>
          <Input
            type="text"
            value={option.label}
            onChange={(e) => updateLabel(index, e.target.value)}
            disabled={disabled}
            className="flex-1"
          />
          <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--muted)]">
            <input type="checkbox" checked={option.active} onChange={() => toggleActive(index)} disabled={disabled} />
            Active
          </label>
          {!option.id && (
            <button
              type="button"
              onClick={() => removeNew(index)}
              disabled={disabled}
              className="shrink-0 text-[var(--error)] hover:opacity-80 disabled:opacity-30"
              aria-label="Remove option"
            >
              <IconTrash size={16} />
            </button>
          )}
        </div>
      ))}
      <div className="flex items-center gap-1.5 pt-1">
        <Input
          type="text"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Add an option…"
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addOption();
            }
          }}
          className="flex-1"
        />
        <Button type="button" variant="secondary" size="sm" onClick={addOption} disabled={disabled || !newLabel.trim()}>
          <IconPlus size={14} className="mr-1" />
          Add
        </Button>
      </div>
    </div>
  );
}
