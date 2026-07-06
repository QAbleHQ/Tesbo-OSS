"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  getInvitationByToken,
  startInviteRegistration,
  verifyInviteRegistration,
  startInviteOtpRegistration,
  verifyInviteOtpRegistration,
  type InviteDetails,
} from "@/lib/api";
import { BrandLogo } from "@/components/BrandLogo";
import { Button, Card, CardBody, CardHeader, CardTitle, Field, FieldError, FieldLabel, FieldHint, Input } from "@/components/ui";

type Mode = "password" | "otp";
type Step = "form" | "code";

function roleLabel(role: string): string {
  const n = (role ?? "").trim().toLowerCase();
  if (n === "manager" || n === "admin") return "Manager";
  if (n === "owner") return "Owner";
  return "QA Engineer";
}

export default function RegisterFromInvitePage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token as string;

  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [inviteState, setInviteState] = useState<"loading" | "valid" | "invalid">("loading");
  const [mode, setMode] = useState<Mode>("password");
  const [step, setStep] = useState<Step>("form");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getInvitationByToken(token)
      .then((inv) => {
        setInvite(inv);
        if (inv.status === "pending") {
          if (inv.hasAccount) {
            // Already has an account — redirect to the accept page
            router.replace(`/invite/${token}`);
          } else {
            setInviteState("valid");
          }
        } else {
          setInviteState("invalid");
        }
      })
      .catch(() => setInviteState("invalid"));
  }, [token, router]);

  function switchMode(next: Mode) {
    setMode(next);
    setStep("form");
    setError("");
  }

  async function handlePasswordFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim()) { setError("Name is required"); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters"); return; }
    if (password !== confirmPassword) { setError("Passwords do not match"); return; }
    setSubmitting(true);
    try {
      await startInviteRegistration(token, { name: name.trim(), password });
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
      await verifyInviteRegistration(token, code.trim());
      router.push("/projects");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid or expired code");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleOtpFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim()) { setError("Name is required"); return; }
    setSubmitting(true);
    try {
      await startInviteOtpRegistration(token, { name: name.trim() });
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send code");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleOtpCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!code.trim()) { setError("Code is required"); return; }
    setSubmitting(true);
    try {
      await verifyInviteOtpRegistration(token, code.trim());
      router.push("/projects");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid or expired code");
    } finally {
      setSubmitting(false);
    }
  }

  if (inviteState === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-[var(--ink-400)]">Loading…</p>
      </div>
    );
  }

  if (inviteState === "invalid") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--ink-50)] px-4 py-12">
        <div className="mb-8"><BrandLogo className="h-10 w-auto" /></div>
        <Card className="w-full max-w-md p-8">
          <CardHeader><CardTitle>Invitation unavailable</CardTitle></CardHeader>
          <CardBody>
            <p className="text-sm text-[var(--ink-400)]">
              This invitation is no longer valid. It may have expired or been cancelled.
            </p>
            <Link href="/login" className="mt-4 inline-block">
              <Button variant="secondary">Go to sign in</Button>
            </Link>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--ink-50)] px-4 py-12">
      <div className="mb-8"><BrandLogo className="h-10 w-auto" /></div>

      <Card className="w-full max-w-md p-8">
        <CardHeader>
          <CardTitle>Create your account</CardTitle>
        </CardHeader>
        <CardBody>
          {invite && (
            <div className="mb-5 rounded-[var(--radius-control)] bg-[var(--ink-100)] px-4 py-3 text-sm">
              <p className="text-[var(--ink-400)]">
                Joining{" "}
                <strong className="text-[var(--foreground)]">
                  {invite.organizationName ?? "the workspace"}
                </strong>{" "}
                as{" "}
                <strong className="text-[var(--foreground)]">{roleLabel(invite.role)}</strong>
              </p>
              <p className="mt-0.5 text-xs text-[var(--ink-400)]">{invite.email}</p>
            </div>
          )}

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
                <FieldLabel htmlFor="reg-name">Full name</FieldLabel>
                <Input
                  id="reg-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  disabled={submitting}
                  autoFocus
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="reg-email">Email</FieldLabel>
                <Input
                  id="reg-email"
                  type="email"
                  value={invite?.email ?? ""}
                  disabled
                  className="opacity-60"
                />
                <FieldHint>Set by the invite — cannot be changed</FieldHint>
              </Field>

              <Field>
                <FieldLabel htmlFor="reg-password">Password</FieldLabel>
                <Input
                  id="reg-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  disabled={submitting}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="reg-confirm">Confirm password</FieldLabel>
                <Input
                  id="reg-confirm"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat your password"
                  disabled={submitting}
                />
              </Field>

              {error && <FieldError>{error}</FieldError>}

              <Button type="submit" disabled={submitting} className="w-full">
                {submitting ? "Sending code…" : "Send verification code"}
              </Button>
            </form>
          )}

          {mode === "password" && step === "code" && (
            <form onSubmit={handlePasswordCodeSubmit} className="space-y-4">
              <FieldHint>We sent a code to {invite?.email}. Enter it below to finish joining.</FieldHint>
              <Field>
                <FieldLabel htmlFor="reg-code">Code</FieldLabel>
                <Input
                  id="reg-code"
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
              <Button type="submit" disabled={submitting} className="w-full">
                {submitting ? "Verifying…" : "Verify and join"}
              </Button>
              <button
                type="button"
                onClick={() => { setStep("form"); setError(""); }}
                className="w-full text-center text-sm font-medium text-[var(--denim)] hover:underline"
              >
                Back
              </button>
            </form>
          )}

          {mode === "otp" && step === "form" && (
            <form onSubmit={handleOtpFormSubmit} className="space-y-4">
              <Field>
                <FieldLabel htmlFor="reg-otp-name">Full name</FieldLabel>
                <Input
                  id="reg-otp-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  disabled={submitting}
                  autoFocus
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="reg-otp-email">Email</FieldLabel>
                <Input
                  id="reg-otp-email"
                  type="email"
                  value={invite?.email ?? ""}
                  disabled
                  className="opacity-60"
                />
                <FieldHint>We will send a one-time code to this email. No password needed.</FieldHint>
              </Field>

              {error && <FieldError>{error}</FieldError>}

              <Button type="submit" disabled={submitting} className="w-full">
                {submitting ? "Sending code…" : "Send verification code"}
              </Button>
            </form>
          )}

          {mode === "otp" && step === "code" && (
            <form onSubmit={handleOtpCodeSubmit} className="space-y-4">
              <FieldHint>We sent a code to {invite?.email}. Enter it below to finish joining.</FieldHint>
              <Field>
                <FieldLabel htmlFor="reg-otp-code">Code</FieldLabel>
                <Input
                  id="reg-otp-code"
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
              <Button type="submit" disabled={submitting} className="w-full">
                {submitting ? "Verifying…" : "Verify and join"}
              </Button>
              <button
                type="button"
                onClick={() => { setStep("form"); setError(""); }}
                className="w-full text-center text-sm font-medium text-[var(--denim)] hover:underline"
              >
                Back
              </button>
            </form>
          )}

          <p className="mt-4 text-center text-xs text-[var(--ink-400)]">
            Already have an account?{" "}
            <Link
              href={`/login?redirect=${encodeURIComponent(`/invite/${token}`)}&inviteEmail=${encodeURIComponent(invite?.email ?? "")}`}
              className="text-[var(--denim)] hover:underline"
            >
              Sign in
            </Link>
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
