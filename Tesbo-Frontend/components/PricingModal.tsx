"use client";

import { useEffect, useState } from "react";
import { IconCheck } from "@tabler/icons-react";
import { Button, Modal } from "@/components/ui";
import { cx } from "@/components/ui/cx";
import { createCheckoutSession, getBillingPricing, type BillingInfo, type BillingInterval, type BillingPricing } from "@/lib/api";

type PricingModalProps = {
  open: boolean;
  onClose: () => void;
  billingInfo: BillingInfo | null;
};

const LAUNCH_FEATURES = [
  "Up to 2 projects",
  "500 MB total workspace storage",
  "Unlimited team members",
  "Unlimited test cases, plans, runs, and activity within your 2 projects",
  "Bring your own AI provider keys",
  "1 core agent",
  "Jira integration",
];

const PRO_FEATURES = [
  "Unlimited projects",
  "Unlimited team members",
  "Unlimited test cases, plans, runs, and workspace activity",
  "5 GB total workspace storage",
  "Bring your own AI provider keys",
  "Full agent marketplace",
  "Jira, Linear, and more integrations as they become available",
];

export default function PricingModal({ open, onClose, billingInfo }: PricingModalProps) {
  const [interval, setInterval] = useState<BillingInterval>("annual");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [pricing, setPricing] = useState<BillingPricing | null>(null);

  const currentPlan = billingInfo?.plan ?? "launch";

  useEffect(() => {
    if (!open) return;
    getBillingPricing()
      .then(setPricing)
      .catch(() => setPricing(null));
  }, [open]);

  // Falls back to the USD list price while /pricing is loading (or if it fails), so the
  // modal never shows a blank/broken amount — the real, currency-matched price replaces
  // it as soon as the buyer's location has been resolved.
  const currency = pricing?.currency ?? "usd";
  const currencySymbol = currency === "inr" ? "₹" : "$";
  const locale = currency === "inr" ? "en-IN" : "en-US";
  const monthlyAmount = (pricing?.monthlyAmount ?? 4000) / 100;
  const annualAmount = (pricing?.annualAmount ?? 36000) / 100;
  const annualPerMonth = annualAmount / 12;

  function formatAmount(amount: number): string {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: Number.isInteger(amount) ? 0 : 2 }).format(amount);
  }

  async function handleUpgrade() {
    setError("");
    setSubmitting(true);
    try {
      const { url } = await createCheckoutSession(interval);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start checkout");
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} className="max-w-[880px]">
      <div className="mb-5">
        <h2 className="text-[24px] font-semibold leading-[1.2] tracking-[-0.02em] text-[var(--ink-800)]">
          Test management that scales, without the pricing maze.
        </h2>
        <p className="mt-1.5 text-[14px] text-[var(--muted-soft)]">
          Every plan below runs on Tesbo Cloud — priced per workspace, with unlimited team members, never per seat.
        </p>
      </div>

      <div className="mb-5 flex justify-center">
        <div className="inline-flex rounded-full border border-[var(--border)] bg-[var(--surface-secondary)] p-1">
          <button
            type="button"
            onClick={() => setInterval("annual")}
            className={cx(
              "rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors",
              interval === "annual"
                ? "bg-[var(--surface)] text-[var(--foreground)] shadow-sm"
                : "text-[var(--muted-soft)] hover:text-[var(--foreground)]"
            )}
          >
            Annual <span className="text-[var(--success-foreground)]">· best value</span>
          </button>
          <button
            type="button"
            onClick={() => setInterval("monthly")}
            className={cx(
              "rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors",
              interval === "monthly"
                ? "bg-[var(--surface)] text-[var(--foreground)] shadow-sm"
                : "text-[var(--muted-soft)] hover:text-[var(--foreground)]"
            )}
          >
            Monthly
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-5">
          <div className="mb-1 text-[13px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-soft)]">Launch</div>
          <div className="mb-1 flex items-baseline gap-1">
            <span className="text-[28px] font-semibold text-[var(--ink-800)]">{currencySymbol}0</span>
            <span className="text-[13px] text-[var(--muted-soft)]">/ workspace / month</span>
          </div>
          <p className="mb-4 text-[13px] text-[var(--muted-soft)]">Free forever — a permanent plan, not a trial.</p>
          <ul className="mb-5 space-y-2">
            {LAUNCH_FEATURES.map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-[13px] text-[var(--ink-600)]">
                <IconCheck size={16} className="mt-0.5 shrink-0 text-[var(--muted-soft)]" />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
          <Button variant="secondary" fullWidth disabled>
            {currentPlan === "launch" ? "Current plan" : "Included"}
          </Button>
        </div>

        <div className="relative rounded-[10px] border-2 border-[var(--brand-primary)] bg-[var(--brand-surface)] p-5 shadow-[var(--shadow-elevated)]">
          {interval === "annual" && (
            <span className="absolute -top-3 right-5 rounded-full bg-[var(--success)] px-2.5 py-0.5 text-[11px] font-semibold text-white">
              Best value
            </span>
          )}
          <div className="mb-1 text-[13px] font-semibold uppercase tracking-[0.06em] text-[var(--brand-primary)]">Pro</div>
          <div className="mb-1 flex items-baseline gap-1">
            <span className="text-[28px] font-semibold text-[var(--ink-800)]">
              {currencySymbol}
              {formatAmount(interval === "annual" ? annualPerMonth : monthlyAmount)}
            </span>
            <span className="text-[13px] text-[var(--muted-soft)]">/ workspace / month</span>
          </div>
          <p className="mb-4 text-[13px] text-[var(--muted-soft)]">
            {interval === "annual" ? `Billed annually at ${currencySymbol}${formatAmount(annualAmount)}/year.` : "Billed monthly."}
          </p>
          <ul className="mb-5 space-y-2">
            {PRO_FEATURES.map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-[13px] text-[var(--ink-600)]">
                <IconCheck size={16} className="mt-0.5 shrink-0 text-[var(--brand-primary)]" />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
          {error && <p className="mb-2 text-[12px] text-[var(--error-foreground)]">{error}</p>}
          <Button fullWidth disabled={submitting || currentPlan === "pro"} onClick={handleUpgrade}>
            {currentPlan === "pro" ? "Current plan" : submitting ? "Redirecting…" : "Upgrade to Pro"}
          </Button>
        </div>
      </div>

      <p className="mt-5 text-center text-[12px] text-[var(--muted-soft)]">
        Prefer to run it yourself?{" "}
        <a
          href="https://github.com/QAbleHQ/Tesbo-Test-Manager"
          target="_blank"
          rel="noreferrer"
          className="font-medium text-[var(--brand-primary)] hover:underline"
        >
          Self-host Tesbo →
        </a>{" "}
        Open source, free forever, unlimited everything on your own infrastructure.
      </p>
    </Modal>
  );
}
