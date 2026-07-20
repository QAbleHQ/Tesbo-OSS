"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { getSetupStatus, loginWithPassword, requestOtp } from "@/lib/api";
import { AuthSplitShell } from "@/components/auth/AuthSplitShell";
import { AuthModeToggle } from "@/components/auth/AuthModeToggle";
import { Button, Field, FieldError, FieldHint, FieldLabel, Input, PasswordInput } from "@/components/ui";

function AuthLoadingScreen() {
  return (
    <div className="dark flex min-h-screen items-center justify-center bg-[#0d0d1a]" style={{ colorScheme: "dark" }}>
      <p className="text-sm text-white/40">Loading...</p>
    </div>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirect = searchParams.get("redirect");
  const inviteEmail = searchParams.get("inviteEmail")?.trim().toLowerCase() || "";
  const isInviteEmailLocked = Boolean(inviteEmail);
  const [email, setEmail] = useState(inviteEmail);
  const [password, setPassword] = useState("");
  const [otpMode, setOtpMode] = useState(Boolean(inviteEmail));
  const [checkingSetup, setCheckingSetup] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getSetupStatus()
      .then((status) => {
        if (status.required) {
          router.replace("/setup");
          return;
        }
        setCheckingSetup(false);
      })
      .catch(() => setCheckingSetup(false));
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const emailToUse = (isInviteEmailLocked ? inviteEmail : email).trim().toLowerCase();
    if (!emailToUse) {
      setError("Email is required");
      return;
    }
    if (!otpMode && !password) {
      setError("Password is required");
      return;
    }

    setLoading(true);
    try {
      if (otpMode) {
        await requestOtp(emailToUse);
        const qp = new URLSearchParams({ email: emailToUse });
        if (redirect) qp.set("redirect", redirect);
        if (isInviteEmailLocked) {
          qp.set("inviteEmail", inviteEmail);
          qp.set("lockEmail", "1");
        }
        router.push(`/verify-otp?${qp.toString()}`);
      } else {
        await loginWithPassword(emailToUse, password);
        router.push(redirect || "/projects");
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed.");
    } finally {
      setLoading(false);
    }
  }

  if (checkingSetup) {
    return <AuthLoadingScreen />;
  }

  return (
    <AuthSplitShell>
      <div className="auth-fade-slide">
        <div className="mb-1 text-[22px] font-bold tracking-tight text-[var(--foreground)]">Welcome back</div>
        <p className="mb-7 text-[13px] text-[var(--muted)]">
          {otpMode ? "Sign in with a one-time code" : "Sign in to your workspace"}
        </p>

        {!isInviteEmailLocked && (
          <AuthModeToggle
            mode={otpMode ? "otp" : "password"}
            onChange={(mode) => setOtpMode(mode === "otp")}
            disabled={loading}
          />
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              disabled={loading || isInviteEmailLocked}
            />
            {isInviteEmailLocked && (
              <FieldHint>This invitation can only be accepted with this email address.</FieldHint>
            )}
          </Field>

          {!otpMode && (
            <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <PasswordInput
                id="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
                disabled={loading}
              />
              <FieldHint>Use the password created during initial setup.</FieldHint>
            </Field>
          )}

          {otpMode && <FieldHint>We&apos;ll send a one-time code to your email address.</FieldHint>}

          {error && <FieldError>{error}</FieldError>}

          <Button
            type="submit"
            disabled={loading}
            fullWidth
            style={{ background: "linear-gradient(135deg, var(--cta-primary), var(--denim-200))" }}
          >
            {loading ? (otpMode ? "Sending..." : "Signing in...") : otpMode ? "Send login code" : "Sign in"}
          </Button>
        </form>

        {!isInviteEmailLocked && (
          <p className="mt-6 text-center text-[13px] text-[var(--muted)]">
            Don&apos;t have an account?{" "}
            <Link href="/signup" className="font-medium text-[var(--brand-primary)] hover:underline">
              Sign up
            </Link>
          </p>
        )}

        <p className="mt-6 text-center text-xs text-[var(--muted-soft)]">
          <Link href="/privacy-policy" className="hover:underline">
            Privacy Policy
          </Link>{" "}
          ·{" "}
          <Link href="/terms-and-conditions" className="hover:underline">
            Terms and Conditions
          </Link>
        </p>
      </div>
    </AuthSplitShell>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<AuthLoadingScreen />}>
      <LoginForm />
    </Suspense>
  );
}
