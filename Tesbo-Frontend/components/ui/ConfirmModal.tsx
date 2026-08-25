"use client";

import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";

type ConfirmModalProps = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: "destructive" | "primary";
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * A shared Yes/No confirmation dialog for destructive actions — styled like the rest of the app
 * (Modal + Button) instead of the browser's native window.confirm(), which can't be themed and
 * looks out of place next to everything else here.
 */
export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmVariant = "destructive",
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  return (
    <Modal
      open={open}
      onClose={() => {
        if (!loading) onCancel();
      }}
      title={title}
    >
      <div className="space-y-5">
        <p className="text-sm leading-relaxed text-[var(--muted)]">{message}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button type="button" variant={confirmVariant} onClick={onConfirm} disabled={loading}>
            {loading ? "Removing…" : confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
