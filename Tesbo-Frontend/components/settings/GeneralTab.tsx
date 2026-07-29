"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getWorkspace, updateWorkspace } from "@/lib/api";
import { countryOptions } from "@/lib/countries";
import { Button, Card, Field, FieldError, FieldHint, FieldLabel, Input, Select } from "@/components/ui";

export default function GeneralTab() {
  const [name, setName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [country, setCountry] = useState("");
  const [savedCountry, setSavedCountry] = useState("");
  const countries = useMemo(() => countryOptions(), []);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    try {
      const workspace = await getWorkspace();
      setName(workspace.name || "");
      setSavedName(workspace.name || "");
      setCountry(workspace.country || "");
      setSavedCountry(workspace.country || "");
    } catch (e) {
      setError((e as Error).message || "Failed to load workspace");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Workspace name is required");
      return;
    }
    if (trimmed === savedName && country === savedCountry) return;
    setSaving(true);
    try {
      await updateWorkspace({ name: trimmed, country });
      showToast("Workspace details updated");
      // Sidebar, workspace switcher, and this page's header all read the name
      // from separate client-side fetches — reload so they all pick it up.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update workspace");
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
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-[var(--foreground)]">General</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Basic details for this workspace.
        </p>
      </div>

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 rounded-[var(--radius-control)] bg-[var(--ink-800)] px-4 py-2.5 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}

      <Card className="p-5">
        <form onSubmit={handleSubmit} className="max-w-md space-y-4">
          <Field>
            <FieldLabel htmlFor="workspace-name">Workspace name</FieldLabel>
            <Input
              id="workspace-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Team"
              disabled={saving}
              maxLength={255}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="workspace-country">Country</FieldLabel>
            <Select id="workspace-country" value={country} onChange={(e) => setCountry(e.target.value)} disabled={saving}>
              <option value="">Not set</option>
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </Select>
            <FieldHint>
              Helps pick the right currency at checkout. Your location is detected automatically at checkout — this is only used as
              a fallback when that isn&apos;t possible.
            </FieldHint>
          </Field>

          {error && <FieldError>{error}</FieldError>}

          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={saving || !name.trim() || (name.trim() === savedName && country === savedCountry)}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
