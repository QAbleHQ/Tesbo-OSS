"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { requestOtp, startSignup, verifySignup } from "@/lib/api";
import { BrandLogo } from "@/components/BrandLogo";
import { Button, Card, CardBody, CardHeader, CardTitle, Field, FieldError, FieldHint, FieldLabel, Input } from "@/components/ui";

type Mode = "password" | "otp";
type Step = "form" | "code";

export default function SignupPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("password");
  const [step, setStep] = useState<Step>("form");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  function switchMode(next: Mode) {
    setMode(next);
    setStep("form");
    setError("");
  }

  async function handlePasswordFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim()) { setError("Name is required"); return; }
    if (!email.trim()) { setError("Email is required"); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters"); return; }
    if (password !== confirmPassword) { setError("Passwords do not match"); return; }
    setSubmitting(true);
    try {
      await startSignup({ name: name.trim(), email: email.trim().toLowerCase(), password });
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start signup");
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePasswordCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!code.trim()) { setError("Code is required"); return; }
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

  async function handleOtpSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const emailToUse = email.trim().toLowerCase();
    if (!emailToUse) { setError("Email is required"); return; }
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

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--ink-50)] px-4 py-12">
      <div className="mb-8"><BrandLogo className="h-10 w-auto" /></div>

      <Card className="w-full max-w-md p-8">
        <CardHeader>
          <CardTitle>Create your account</CardTitle>
        </CardHeader>
        <CardBody>
          {step === "form" && (
            <div className="mb-5 flex gap-2">
              <Button
                type="button"
                variant={mode === "password" ? "primary" : "secondary"}
                size="sm"
                className="flex-1"
                onClick={() => switchMode("password")}
              >
                Password
              </Button>
              <Button
                type="button"
                variant={mode === "otp" ? "primary" : "secondary"}
                size="sm"
                className="flex-1"
                onClick={() => switchMode("otp")}
              >
                Email code
              </Button>
            </div>
          )}

          {mode === "password" && step === "form" && (
            <form onSubmit={handlePasswordFormSubmit} className="space-y-4">
              <Field>
                <FieldLabel htmlFor="signup-name">Full name</FieldLabel>
                <Input
                  id="signup-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  disabled={submitting}
                  autoFocus
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="signup-email">Email</FieldLabel>
                <Input
                  id="signup-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  disabled={submitting}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="signup-password">Password</FieldLabel>
                <Input
                  id="signup-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  disabled={submitting}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="signup-confirm">Confirm password</FieldLabel>
                <Input
                  id="signup-confirm"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat your password"
                  disabled={submitting}
                />
              </Field>
              {error && <FieldError>{error}</FieldError>}
              <Button type="submit" disabled={submitting} fullWidth>
                {submitting ? "Sending code..." : "Send verification code"}
              </Button>
            </form>
          )}

          {mode === "password" && step === "code" && (
            <form onSubmit={handlePasswordCodeSubmit} className="space-y-4">
              <FieldHint>We sent a code to {email}. Enter it below to create your account.</FieldHint>
              <Field>
                <FieldLabel htmlFor="signup-code">Code</FieldLabel>
                <Input
                  id="signup-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  className="text-center text-lg tracking-widest"
                  maxLength={6}
                  disabled={submitting}
                  autoFocus
                />
              </Field>
              {error && <FieldError>{error}</FieldError>}
              <Button type="submit" disabled={submitting} fullWidth>
                {submitting ? "Verifying..." : "Verify and create account"}
              </Button>
              <button
                type="button"
                onClick={() => { setStep("form"); setError(""); }}
                className="w-full text-center text-sm font-medium text-[var(--brand-primary)] hover:underline"
              >
                Use a different email
              </button>
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
                  placeholder="you@example.com"
                  disabled={submitting}
                  autoFocus
                />
                <FieldHint>We will send a one-time code to your email. No password needed.</FieldHint>
              </Field>
              {error && <FieldError>{error}</FieldError>}
              <Button type="submit" disabled={submitting} fullWidth>
                {submitting ? "Sending..." : "Send login code"}
              </Button>
            </form>
          )}

          <p className="mt-4 text-center text-xs text-[var(--ink-400)]">
            Already have an account?{" "}
            <Link href="/login" className="text-[var(--denim)] hover:underline">
              Sign in
            </Link>
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
