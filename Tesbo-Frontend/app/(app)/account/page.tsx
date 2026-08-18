"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authMe, changePassword } from "@/lib/api";
import { Button, Card, Field, FieldError, FieldHint, FieldLabel, PasswordInput } from "@/components/ui";
import { PASSWORD_MAX_LENGTH, PASSWORD_RULES_HINT, validatePasswordValue } from "@/lib/validation";

export default function AccountPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [hasPassword, setHasPassword] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    const me = await authMe();
    if (!me) {
      router.replace("/login");
      return;
    }
    setEmail(me.email ?? "");
    setName((me.name ?? "").trim());
    setHasPassword(Boolean(me.hasPassword));
    setLoading(false);
  }, [router]);

  useEffect(() => { void load(); }, [load]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 4000);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (hasPassword && !currentPassword) {
      setError("Current password is required");
      return;
    }
    const passwordError = validatePasswordValue(newPassword);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New passwords do not match");
      return;
    }
    setSaving(true);
    try {
      await changePassword(hasPassword ? currentPassword : null, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setHasPassword(true);
      showToast("Password changed. You've been signed out of all other sessions.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center">
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <div>
        <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-[var(--foreground)]">My Account</h1>
        <p className="mt-1 text-[13px] text-[var(--muted-soft)]">Manage your personal account settings.</p>
      </div>

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 rounded-[var(--radius-control)] bg-[var(--toast-surface)] px-4 py-2.5 text-sm text-[var(--toast-foreground)] shadow-lg">
          {toast}
        </div>
      )}

      <Card className="p-5 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">Profile</h2>
        </div>
        {/*
          * Basecamp 10212498688 — the profile showed nothing but the email. Signup collects First name
          * and Last name and GET /me has always returned them as a single `name`; this screen simply
          * never rendered it. Read-only for now: there is no PATCH /me to save an edit through.
          *
          * The mobile number the card also asks for is NOT shown, because signup never collects one —
          * there is no field, no column and no value to fetch. Raised separately for Specification
          * rather than rendered as a permanently empty row.
          */}
        <Field>
          <FieldLabel htmlFor="account-name">Name</FieldLabel>
          <div id="account-name" className="text-sm text-[var(--foreground)]">
            {name || <span className="text-[var(--muted-soft)]">Not set</span>}
          </div>
        </Field>
        <Field>
          <FieldLabel htmlFor="account-email">Email</FieldLabel>
          <div id="account-email" className="text-sm text-[var(--foreground)]">
            {email}
          </div>
        </Field>
      </Card>

      <Card className="p-5">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-[var(--foreground)]">
            {hasPassword ? "Change password" : "Set a password"}
          </h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {hasPassword
              ? "You'll be signed out of all other active sessions after changing your password."
              : "You signed in with a one-time code so far. Set a password to also sign in that way."}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="max-w-md space-y-4">
          {hasPassword && (
            <Field>
              <FieldLabel htmlFor="current-password">Current password</FieldLabel>
              <PasswordInput
                id="current-password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Your current password"
                disabled={saving}
                maxLength={PASSWORD_MAX_LENGTH}
              />
            </Field>
          )}

          <Field>
            <FieldLabel htmlFor="new-password">New password</FieldLabel>
            <PasswordInput
              id="new-password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 8 characters"
              disabled={saving}
              maxLength={PASSWORD_MAX_LENGTH}
            />
            <FieldHint>{PASSWORD_RULES_HINT}</FieldHint>
          </Field>

          <Field>
            <FieldLabel htmlFor="confirm-new-password">Confirm new password</FieldLabel>
            <PasswordInput
              id="confirm-new-password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter your new password"
              disabled={saving}
              maxLength={PASSWORD_MAX_LENGTH}
            />
          </Field>

          {error && <FieldError>{error}</FieldError>}

          <div className="flex justify-end">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : hasPassword ? "Change password" : "Set password"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
