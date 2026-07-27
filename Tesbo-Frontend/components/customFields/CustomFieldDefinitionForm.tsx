"use client";

import { useEffect, useState } from "react";
import {
  createCustomFieldDefinition,
  setCustomFieldDefinitionStatus,
  updateCustomFieldDefinition,
  type CustomFieldConfig,
  type CustomFieldDefinition,
  type CustomFieldType,
} from "@/lib/api";
import { Button, Field, FieldError, FieldHint, FieldLabel, Input, Select, Textarea } from "@/components/ui";
import { FIELD_TYPE_OPTIONS, slugPreview } from "./customFieldTypes";
import CustomFieldOptionsEditor, { nextLocalKey, type DraftOption } from "./CustomFieldOptionsEditor";

function optionsToDraft(config: CustomFieldConfig | undefined): DraftOption[] {
  return (config?.options || [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((o) => ({ localKey: nextLocalKey(), id: o.id, label: o.label, active: o.active }));
}

export default function CustomFieldDefinitionForm({
  projectId,
  definition,
  onCancel,
  onSaved,
}: {
  projectId: string;
  definition: CustomFieldDefinition | null;
  onCancel: () => void;
  onSaved: (definition: CustomFieldDefinition) => void;
}) {
  const isEditing = Boolean(definition);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [fieldType, setFieldType] = useState<CustomFieldType>("text");
  const [required, setRequired] = useState(false);
  const [active, setActive] = useState(true);
  const [options, setOptions] = useState<DraftOption[]>([]);
  const [maxLength, setMaxLength] = useState("");
  const [placeholder, setPlaceholder] = useState("");
  const [defaultText, setDefaultText] = useState("");
  const [displayFormat, setDisplayFormat] = useState<"yes_no" | "true_false">("yes_no");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [decimalsAllowed, setDecimalsAllowed] = useState(true);
  const [unit, setUnit] = useState("");
  const [defaultNumber, setDefaultNumber] = useState("");
  const [minSelected, setMinSelected] = useState("");
  const [maxSelected, setMaxSelected] = useState("");
  const [allowPastDates, setAllowPastDates] = useState(true);
  const [allowFutureDates, setAllowFutureDates] = useState(true);
  const [defaultDate, setDefaultDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const config = definition?.config;
    setName(definition?.name || "");
    setDescription(definition?.description || "");
    setFieldType(definition?.fieldType || "text");
    setRequired(definition?.required || false);
    setActive(definition ? definition.status !== "inactive" : true);
    setOptions(optionsToDraft(config));
    setMaxLength(config?.maxLength != null ? String(config.maxLength) : "");
    setPlaceholder(config?.placeholder || "");
    setDefaultText(typeof config?.defaultValue === "string" && (definition?.fieldType === "text" || definition?.fieldType === "long_text") ? config.defaultValue : "");
    setDisplayFormat(config?.displayFormat || "yes_no");
    setMin(config?.min != null ? String(config.min) : "");
    setMax(config?.max != null ? String(config.max) : "");
    setDecimalsAllowed(config?.decimalsAllowed !== false);
    setUnit(config?.unit || "");
    setDefaultNumber(typeof config?.defaultValue === "number" ? String(config.defaultValue) : "");
    setMinSelected(config?.minSelected != null ? String(config.minSelected) : "");
    setMaxSelected(config?.maxSelected != null ? String(config.maxSelected) : "");
    setAllowPastDates(config?.allowPastDates !== false);
    setAllowFutureDates(config?.allowFutureDates !== false);
    setDefaultDate(definition?.fieldType === "date" && typeof config?.defaultValue === "string" ? config.defaultValue : "");
    setError(null);
  }, [definition]);

  function buildConfig(): CustomFieldConfig {
    switch (fieldType) {
      case "text":
      case "long_text":
        return {
          maxLength: maxLength.trim() ? Number(maxLength) : null,
          placeholder: placeholder.trim() || null,
          defaultValue: defaultText.trim() || undefined,
        };
      case "boolean":
        return { displayFormat };
      case "single_select":
      case "multi_select":
        return {
          options: options.map((o, index) => ({ id: o.id as string, label: o.label, active: o.active, order: index })),
          ...(fieldType === "multi_select"
            ? {
                minSelected: minSelected.trim() ? Number(minSelected) : null,
                maxSelected: maxSelected.trim() ? Number(maxSelected) : null,
              }
            : {}),
        };
      case "number":
        return {
          min: min.trim() ? Number(min) : null,
          max: max.trim() ? Number(max) : null,
          decimalsAllowed,
          unit: unit.trim() || null,
          defaultValue: defaultNumber.trim() ? Number(defaultNumber) : undefined,
        };
      case "date":
        return {
          allowPastDates,
          allowFutureDates,
          defaultValue: defaultDate.trim() || undefined,
        };
      default:
        return {};
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Field name is required.");
      return;
    }
    if ((fieldType === "single_select" || fieldType === "multi_select") && options.length === 0) {
      setError("Add at least one option.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const config = buildConfig();
      if (isEditing && definition) {
        let saved = await updateCustomFieldDefinition(projectId, definition.id, {
          name: trimmedName,
          description: description.trim() || null,
          required,
          config,
        });
        const wasActive = definition.status !== "inactive";
        if (active !== wasActive) {
          saved = await setCustomFieldDefinitionStatus(projectId, definition.id, active ? "active" : "inactive");
        }
        onSaved(saved);
      } else {
        const saved = await createCustomFieldDefinition(projectId, {
          name: trimmedName,
          description: description.trim() || undefined,
          fieldType,
          required,
          active,
          config,
        });
        onSaved(saved);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save custom field.");
    } finally {
      setSaving(false);
    }
  }

  const isSelectType = fieldType === "single_select" || fieldType === "multi_select";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field>
        <FieldLabel>Field name</FieldLabel>
        <Input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus disabled={saving} />
        {!isEditing && name.trim() && <FieldHint>Key: {slugPreview(name)}</FieldHint>}
      </Field>

      <Field>
        <FieldLabel>Description / helper text</FieldLabel>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} disabled={saving} />
      </Field>

      <Field>
        <FieldLabel>Field type</FieldLabel>
        <Select value={fieldType} onChange={(e) => setFieldType(e.target.value as CustomFieldType)} disabled={saving || isEditing}>
          {FIELD_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
        {isEditing && <FieldHint>Field type can&apos;t be changed after creation — archive this field and create a new one instead.</FieldHint>}
      </Field>

      {(fieldType === "text" || fieldType === "long_text") && (
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel>Max length</FieldLabel>
            <Input type="number" min={1} value={maxLength} onChange={(e) => setMaxLength(e.target.value)} disabled={saving} />
          </Field>
          <Field>
            <FieldLabel>Placeholder</FieldLabel>
            <Input type="text" value={placeholder} onChange={(e) => setPlaceholder(e.target.value)} disabled={saving} />
          </Field>
          <Field className="col-span-2">
            <FieldLabel>Default value</FieldLabel>
            <Input type="text" value={defaultText} onChange={(e) => setDefaultText(e.target.value)} disabled={saving} />
          </Field>
        </div>
      )}

      {fieldType === "boolean" && (
        <Field>
          <FieldLabel>Display format</FieldLabel>
          <Select value={displayFormat} onChange={(e) => setDisplayFormat(e.target.value as "yes_no" | "true_false")} disabled={saving}>
            <option value="yes_no">Yes / No</option>
            <option value="true_false">True / False</option>
          </Select>
        </Field>
      )}

      {isSelectType && (
        <Field>
          <FieldLabel>Options</FieldLabel>
          <CustomFieldOptionsEditor options={options} onChange={setOptions} disabled={saving} />
        </Field>
      )}

      {fieldType === "multi_select" && (
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel>Minimum selections</FieldLabel>
            <Input type="number" min={0} value={minSelected} onChange={(e) => setMinSelected(e.target.value)} disabled={saving} />
          </Field>
          <Field>
            <FieldLabel>Maximum selections</FieldLabel>
            <Input type="number" min={1} value={maxSelected} onChange={(e) => setMaxSelected(e.target.value)} disabled={saving} />
          </Field>
        </div>
      )}

      {fieldType === "number" && (
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel>Minimum value</FieldLabel>
            <Input type="number" value={min} onChange={(e) => setMin(e.target.value)} disabled={saving} />
          </Field>
          <Field>
            <FieldLabel>Maximum value</FieldLabel>
            <Input type="number" value={max} onChange={(e) => setMax(e.target.value)} disabled={saving} />
          </Field>
          <Field>
            <FieldLabel>Unit</FieldLabel>
            <Input type="text" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="e.g. hours" disabled={saving} />
          </Field>
          <Field>
            <FieldLabel>Default value</FieldLabel>
            <Input type="number" value={defaultNumber} onChange={(e) => setDefaultNumber(e.target.value)} disabled={saving} />
          </Field>
          <label className="col-span-2 flex items-center gap-2 text-sm text-[var(--foreground)]">
            <input type="checkbox" checked={decimalsAllowed} onChange={(e) => setDecimalsAllowed(e.target.checked)} disabled={saving} />
            Allow decimal values
          </label>
        </div>
      )}

      {fieldType === "date" && (
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel>Default date</FieldLabel>
            <Input type="date" value={defaultDate} onChange={(e) => setDefaultDate(e.target.value)} disabled={saving} />
          </Field>
          <div className="flex flex-col gap-2 pt-6">
            <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
              <input type="checkbox" checked={allowPastDates} onChange={(e) => setAllowPastDates(e.target.checked)} disabled={saving} />
              Allow past dates
            </label>
            <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
              <input type="checkbox" checked={allowFutureDates} onChange={(e) => setAllowFutureDates(e.target.checked)} disabled={saving} />
              Allow future dates
            </label>
          </div>
        </div>
      )}

      <div className="flex items-center gap-4 border-t border-[var(--border)] pt-4">
        <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} disabled={saving} />
          Required
        </label>
        <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} disabled={saving} />
          Active
        </label>
      </div>

      {error && <FieldError>{error}</FieldError>}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : isEditing ? "Save changes" : "Create field"}
        </Button>
      </div>
    </form>
  );
}
