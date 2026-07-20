"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";
import { requestOtp, startSignup, verifySignup } from "@/lib/api";
import { AuthSplitShell } from "@/components/auth/AuthSplitShell";
import { AuthModeToggle, type AuthMode } from "@/components/auth/AuthModeToggle";
import { OtpBoxInput } from "@/components/auth/OtpBoxInput";
import { Button, Field, FieldError, FieldHint, FieldLabel, Input, PasswordInput } from "@/components/ui";

type Step = "form" | "code";

export default function SignupPage() {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>("password");
  const [step, setStep] = useState<Step>("form");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  function switchMode(next: AuthMode) {
    setMode(next);
    setStep("form");
    setError("");
  }

  async function handlePasswordFormSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!firstName.trim() || !lastName.trim()) {
      setError("First and last name are required");
      return;
    }
    if (!email.trim()) {
      setError("Email is required");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setSubmitting(true);
    try {
      await startSignup({
        name: `${firstName.trim()} ${lastName.trim()}`,
        email: email.trim().toLowerCase(),
        password,
      });
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start signup");
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePasswordCodeSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (code.trim().length < 6) {
      setError("Enter the 6-digit code");
      return;
    }
    setSubmitting(true);
    try {
      await verifySignup(email.trim().toLowerCase(), code.trim());
      router.push("/onboarding");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid or expired code");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleOtpSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const emailToUse = email.trim().toLowerCase();
    if (!emailToUse) {
      setError("Email is required");
      return;
    }
    setSubmitting(true);
    try {
      await requestOtp(emailToUse);
      const qp = new URLSearchParams({ email: emailToUse, redirect: "/onboarding" });
      router.push(`/verify-otp?${qp.toString()}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send code");
    } finally {
      setSubmitting(false);
    }
  }

  const gradientCta = { background: "linear-gradient(135deg, var(--cta-primary), var(--denim-200))" };

  return (
    <AuthSplitShell>
      <div className="auth-fade-slide">
        {mode === "password" && step === "code" && (
          <button
            type="button"
            onClick={() => {
              setStep("form");
              setError("");
            }}
            className="mb-6 flex items-center gap-1.5 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            <IconArrowLeft size={14} />
            Back
          </button>
        )}

        <div className="mb-1 text-[22px] font-bold tracking-tight text-[var(--foreground)]">
          {mode === "password" && step === "code" ? "Check your email" : "Create account"}
        </div>
        <p className="mb-7 text-[13px] text-[var(--muted)]">
          {mode === "password" && step === "code"
            ? `We sent a code to ${email}`
            : "Start managing your test suite today"}
        </p>

        {step === "form" && <AuthModeToggle mode={mode} onChange={switchMode} disabled={submitting} />}

        {mode === "password" && step === "form" && (
          <form onSubmit={handlePasswordFormSubmit} className="space-y-4">
            <div className="flex gap-3">
              <Field className="flex-1">
                <FieldLabel htmlFor="signup-first-name">First name</FieldLabel>
                <Input
                  id="signup-first-name"
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="Jane"
                  disabled={submitting}
                  autoFocus
                />
              </Field>
              <Field className="flex-1">
                <FieldLabel htmlFor="signup-last-name">Last name</FieldLabel>
                <Input
                  id="signup-last-name"
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Smith"
                  disabled={submitting}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="signup-email">Work email</FieldLabel>
              <Input
                id="signup-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                disabled={submitting}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="signup-password">Password</FieldLabel>
              <PasswordInput
                id="signup-password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                disabled={submitting}
              />
            </Field>
            {error && <FieldError>{error}</FieldError>}
            <Button type="submit" disabled={submitting} fullWidth style={gradientCta}>
              {submitting ? "Sending code..." : "Create account"}
            </Button>
            <p className="text-center text-[11px] leading-relaxed text-[var(--muted-soft)]">
              By signing up you agree to our{" "}
              <Link href="/terms-and-conditions" className="hover:underline">
                Terms
              </Link>{" "}
              and{" "}
              <Link href="/privacy-policy" className="hover:underline">
                Privacy Policy
              </Link>
            </p>
          </form>
        )}

        {mode === "password" && step === "code" && (
          <form onSubmit={handlePasswordCodeSubmit} className="space-y-5">
            <OtpBoxInput value={code} onChange={setCode} disabled={submitting} autoFocus />
            {error && <FieldError>{error}</FieldError>}
            <Button type="submit" disabled={submitting} fullWidth style={gradientCta}>
              {submitting ? "Verifying..." : "Verify and create account"}
            </Button>
          </form>
        )}

        {mode === "otp" && (
          <form onSubmit={handleOtpSubmit} className="space-y-4">
            <Field>
              <FieldLabel htmlFor="signup-otp-email">Email</FieldLabel>
              <Input
                id="signup-otp-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                disabled={submitting}
                autoFocus
              />
              <FieldHint>We will send a one-time code to your email. No password needed.</FieldHint>
            </Field>
            {error && <FieldError>{error}</FieldError>}
            <Button type="submit" disabled={submitting} fullWidth style={gradientCta}>
              {submitting ? "Sending..." : "Send login code"}
            </Button>
          </form>
        )}

        {step === "form" && (
          <p className="mt-6 text-center text-[13px] text-[var(--muted)]">
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-[var(--brand-primary)] hover:underline">
              Sign in
            </Link>
          </p>
        )}
      </div>
    </AuthSplitShell>
  );
}
