"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  createPortalSession,
  getBillingInfo,
  getBillingUsage,
  getWorkspace,
  type BillingInfo,
  type PlanUsageSummary,
} from "@/lib/api";
import { Button, Card } from "@/components/ui";
import { cx } from "@/components/ui/cx";
import PricingModal from "@/components/PricingModal";

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function UsageBar({ label, used, limit, usedLabel, limitLabel }: {
  label: string;
  used: number;
  limit: number | null;
  usedLabel: string;
  limitLabel: string;
}) {
  const pct = limit == null ? 0 : Math.min(100, (used / limit) * 100);
  const barColor = limit == null ? "" : pct >= 100 ? "bg-[var(--error)]" : pct >= 80 ? "bg-[var(--warning)]" : "bg-[var(--brand-primary)]";

  return (
    <div>
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="font-medium text-[var(--foreground)]">{label}</span>
        <span className="text-[var(--muted-soft)]">
          {usedLabel} {limit == null ? "· unlimited" : `/ ${limitLabel}`}
        </span>
      </div>
      {limit != null && (
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-secondary)]">
          <div className={cx("h-full rounded-full transition-[width]", barColor)} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

export default function BillingTab() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [isOwner, setIsOwner] = useState(false);
  const [billingInfo, setBillingInfo] = useState<BillingInfo | null>(null);
  const [usage, setUsage] = useState<PlanUsageSummary | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [redirecting, setRedirecting] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [workspace, billing, usageSummary] = await Promise.all([getWorkspace(), getBillingInfo(), getBillingUsage()]);
      setIsOwner((workspace.role || "").toLowerCase() === "owner");
      setBillingInfo(billing);
      setUsage(usageSummary);
    } catch (e) {
      setError((e as Error).message || "Failed to load billing information");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 4500);
  }

  useEffect(() => {
    const checkout = searchParams.get("checkout");
    if (!checkout) return;
    if (checkout === "success") {
      showToast("You're on Tesbo Pro. Welcome aboard!");
      load();
    } else if (checkout === "cancelled") {
      showToast("Checkout was cancelled — no changes were made.");
    }
    router.replace("/settings?tab=billing", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function handleManageBilling() {
    setError("");
    setRedirecting(true);
    try {
      const { url } = await createPortalSession();
      window.location.href = url;
    } catch (e) {
      setError((e as Error).message || "Failed to open billing portal");
      setRedirecting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center">
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

  const plan = billingInfo?.plan ?? "launch";

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-[var(--foreground)]">Billing</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Tesbo Cloud plan for this workspace — billed per workspace, with unlimited team members.
        </p>
      </div>

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 rounded-[var(--radius-control)] bg-[var(--ink-800)] px-4 py-2.5 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}

      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold uppercase tracking-[0.06em] text-[var(--brand-primary)]">
                {plan === "pro" ? "Pro" : "Launch"}
              </span>
              {billingInfo?.cancelAtPeriodEnd && billingInfo.currentPeriodEnd && (
                <span className="rounded-full bg-[var(--warning-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--warning-foreground)]">
                  Cancels {formatDate(billingInfo.currentPeriodEnd)}
                </span>
              )}
            </div>
            <p className="mt-1 text-[13px] text-[var(--muted-soft)]">
              {plan === "pro"
                ? billingInfo?.currentPeriodEnd
                  ? `Renews ${formatDate(billingInfo.currentPeriodEnd)}${
                      billingInfo.billingInterval ? ` · billed ${billingInfo.billingInterval}` : ""
                    }`
                  : "Unlimited projects, 5GB storage, and the full agent marketplace."
                : "Free forever — up to 2 projects and 500MB storage, with unlimited team members."}
            </p>
          </div>

          <div className="flex gap-2">
            {isOwner && plan === "pro" && (
              <Button variant="secondary" onClick={handleManageBilling} disabled={redirecting}>
                {redirecting ? "Opening…" : "Manage billing"}
              </Button>
            )}
            {isOwner && plan === "launch" && <Button onClick={() => setPricingOpen(true)}>Upgrade to Pro</Button>}
          </div>
        </div>

        {!isOwner && (
          <p className="mt-4 text-[13px] text-[var(--muted-soft)]">
            Contact your workspace owner to change plans or manage billing.
          </p>
        )}

        {error && <p className="mt-4 text-[13px] text-[var(--error-foreground)]">{error}</p>}
      </Card>

      {usage && (
        <Card className="p-5">
          <h3 className="mb-4 text-[13px] font-semibold text-[var(--foreground)]">Usage</h3>
          <div className="space-y-4">
            <UsageBar
              label="Projects"
              used={usage.projectCount}
              limit={usage.projectLimit}
              usedLabel={String(usage.projectCount)}
              limitLabel={String(usage.projectLimit)}
            />
            <UsageBar
              label="Storage"
              used={usage.storageUsedBytes}
              limit={usage.storageLimitBytes}
              usedLabel={formatBytes(usage.storageUsedBytes)}
              limitLabel={formatBytes(usage.storageLimitBytes)}
            />
          </div>
          {plan === "launch" && (usage.projectCount >= (usage.projectLimit ?? Infinity) || usage.storageUsedBytes >= usage.storageLimitBytes) && (
            <p className="mt-4 text-[13px] text-[var(--warning-foreground)]">
              You&apos;ve hit a Launch plan limit.{" "}
              <button type="button" className="font-medium underline" onClick={() => setPricingOpen(true)}>
                Upgrade to Pro
              </button>{" "}
              for more room.
            </p>
          )}
        </Card>
      )}

      <PricingModal open={pricingOpen} onClose={() => setPricingOpen(false)} billingInfo={billingInfo} />
    </div>
  );
}
