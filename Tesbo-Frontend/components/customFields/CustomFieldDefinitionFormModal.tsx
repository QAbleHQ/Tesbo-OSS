"use client";

import { Modal } from "@/components/ui";
import type { CustomFieldDefinition } from "@/lib/api";
import CustomFieldDefinitionForm from "./CustomFieldDefinitionForm";

export default function CustomFieldDefinitionFormModal({
  open,
  projectId,
  definition,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: string;
  definition: CustomFieldDefinition | null;
  onClose: () => void;
  onSaved: (definition: CustomFieldDefinition) => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title={definition ? "Edit custom field" : "Add custom field"} className="max-w-[640px]">
      <CustomFieldDefinitionForm projectId={projectId} definition={definition} onCancel={onClose} onSaved={onSaved} />
    </Modal>
  );
}
