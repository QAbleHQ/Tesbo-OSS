"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { IconMailOpened } from "@tabler/icons-react";
import { requestPasswordReset } from "@/lib/api";
import { AuthSplitShell } from "@/components/auth/AuthSplitShell";
import { Button, Field, FieldError, FieldLabel, Input } from "@/components/ui";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const emailToUse = email.trim().toLowerCase();
    if (!emailToUse) {
      setError("Email is required");
      return;
    }
    setLoading(true);
    try {
      await requestPasswordReset(emailToUse);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send reset link");
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <AuthSplitShell>
        <div className="auth-fade-slide text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full border border-[rgba(123,110,224,.3)] bg-[rgba(123,110,224,.15)]">
            <IconMailOpened size={26} stroke={1.5} className="text-[var(--brand-primary)]" />
          </div>
          <div className="mb-2 text-[20px] font-bold tracking-tight text-[var(--foreground)]">Check your email</div>
          <p className="mb-7 text-[13px] leading-relaxed text-[var(--muted)]">
            If an account exists for
            <br />
            <span className="font-medium text-[var(--foreground)]">{email}</span>, we&apos;ve sent a link to reset your password.
            It expires in 60 minutes.
          </p>
          <Link href="/login" className="text-[13px] font-medium text-[var(--brand-primary)] hover:underline">
            Back to sign in
          </Link>
        </div>
      </AuthSplitShell>
    );
  }

  return (
    <AuthSplitShell>
      <div className="auth-fade-slide">
        <div className="mb-1 text-[22px] font-bold tracking-tight text-[var(--foreground)]">Forgot password?</div>
        <p className="mb-7 text-[13px] text-[var(--muted)]">
          Enter your email and we&apos;ll send you a link to reset your password.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              disabled={loading}
            />
          </Field>

          {error && <FieldError>{error}</FieldError>}

          <Button
            type="submit"
            disabled={loading}
            fullWidth
            style={{ background: "linear-gradient(135deg, var(--cta-primary), var(--denim-200))" }}
          >
            {loading ? "Sending..." : "Send reset link"}
          </Button>
        </form>

        <p className="mt-6 text-center text-[13px] text-[var(--muted)]">
          <Link href="/login" className="font-medium text-[var(--brand-primary)] hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </AuthSplitShell>
  );
}
