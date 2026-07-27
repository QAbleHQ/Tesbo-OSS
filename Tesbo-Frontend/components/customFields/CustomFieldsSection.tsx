"use client";

import type { CustomFieldConfig, CustomFieldStatus, CustomFieldType } from "@/lib/api";
import { Field, FieldError, FieldHint, FieldLabel, StatusChip } from "@/components/ui";
import CustomFieldValueInput from "./CustomFieldValueInput";
import { formatCustomFieldValueForDisplay } from "./customFieldTypes";

export interface CustomFieldSectionItem {
  id: string;
  name: string;
  description?: string | null;
  fieldType: CustomFieldType;
  status: CustomFieldStatus;
  required: boolean;
  config: CustomFieldConfig;
}

export default function CustomFieldsSection({
  definitions,
  values,
  errors,
  onChange,
  disabled,
}: {
  definitions: CustomFieldSectionItem[];
  values: Record<string, unknown>;
  errors: Record<string, string>;
  onChange: (definitionId: string, value: unknown) => void;
  disabled?: boolean;
}) {
  if (definitions.length === 0) {
    return <p className="text-sm text-[var(--muted)]">No custom fields configured for this project yet.</p>;
  }

  return (
    <div className="space-y-4">
      {definitions.map((definition) => {
        const isActive = definition.status === "active";
        return (
          <Field key={definition.id}>
            <div className="flex items-center gap-2">
              <FieldLabel>
                {definition.name}
                {definition.required && isActive && <span className="text-[var(--error)]"> *</span>}
              </FieldLabel>
              {!isActive && (
                <StatusChip tone="neutral" className="text-[11px]">
                  {definition.status === "archived" ? "Archived" : "Inactive"}
                </StatusChip>
              )}
            </div>
            {definition.description && <FieldHint>{definition.description}</FieldHint>}
            {isActive ? (
              <>
                <CustomFieldValueInput definition={definition} value={values[definition.id]} onChange={(value) => onChange(definition.id, value)} disabled={disabled} />
                {errors[definition.id] && <FieldError>{errors[definition.id]}</FieldError>}
              </>
            ) : (
              <p className="text-sm text-[var(--muted)]">{formatCustomFieldValueForDisplay(definition, values[definition.id])}</p>
            )}
          </Field>
        );
      })}
    </div>
  );
}
