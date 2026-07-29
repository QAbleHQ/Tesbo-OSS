"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, Suspense } from "react";
import { integrationCallback, INTEGRATION_RETURN_PROJECT_KEY, type IntegrationProvider } from "@/lib/api";

const PROVIDER_LABELS: Record<IntegrationProvider, string> = { jira: "Jira", linear: "Linear" };

function CallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const code = searchParams.get("code");
  const oauthError = searchParams.get("error");
  // Signed state, shaped `<provider>.<payload>.<signature>`. Only the leading provider segment is
  // read here — to pick the endpoint — and the whole value goes back for the backend to verify.
  const state = searchParams.get("state") || "";
  const head = state.split(".")[0];
  const provider = head === "jira" || head === "linear" ? head : null;
  const providerLabel = provider ? PROVIDER_LABELS[provider] : "the app";

  // Failures visible straight from the query string need no round trip, so they stay derived rather
  // than being pushed into state from inside the effect.
  const upfrontError = oauthError
    ? "Authorization was denied or failed."
    : !code || !provider
      ? "Missing authorization code or integration context."
      : null;

  const [exchange, setExchange] = useState<{ status: "loading" | "success" | "error"; errorMsg: string }>({
    status: "loading",
    errorMsg: "",
  });

  useEffect(() => {
    if (upfrontError || !code || !provider) return;
    integrationCallback(provider, code, state)
      .then(() => {
        setExchange({ status: "success", errorMsg: "" });
        const returnProjectId = sessionStorage.getItem(INTEGRATION_RETURN_PROJECT_KEY);
        sessionStorage.removeItem(INTEGRATION_RETURN_PROJECT_KEY);
        router.replace(
          returnProjectId ? `/projects/${returnProjectId}/settings/integrations/${provider}` : `/settings/integrations/${provider}`
        );
      })
      .catch((err) => {
        setExchange({ status: "error", errorMsg: err?.message || "Failed to complete authentication." });
      });
  }, [upfrontError, code, provider, state, router]);

  const status = upfrontError ? "error" : exchange.status;
  const errorMsg = upfrontError || exchange.errorMsg;

  return (
    <main className="min-h-screen flex items-center justify-center bg-[var(--background)]">
      <div className="max-w-md w-full mx-auto px-6 py-12 text-center">
        {status === "loading" && (
          <>
            <div className="mx-auto w-10 h-10 rounded-full border-2 border-[var(--brand-primary)] border-t-transparent animate-spin" />
            <h1 className="mt-4 text-lg font-semibold text-[var(--foreground)]">
              Connecting to {providerLabel}…
            </h1>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Please wait while we complete the authentication.
            </p>
          </>
        )}
        {status === "success" && (
          <>
            <div className="mx-auto w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
              <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h1 className="mt-4 text-lg font-semibold text-[var(--foreground)]">
              {providerLabel} Connected!
            </h1>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Redirecting…
            </p>
          </>
        )}
        {status === "error" && (
          <>
            <div className="mx-auto w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
              <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h1 className="mt-4 text-lg font-semibold text-[var(--foreground)]">
              Connection Failed
            </h1>
            <p className="mt-2 text-sm text-red-600">{errorMsg}</p>
            <button
              onClick={() => router.back()}
              className="mt-4 rounded-lg bg-[var(--surface-secondary)] px-4 py-2 text-sm font-medium text-[var(--muted)] hover:bg-[var(--surface-tertiary)]"
            >
              Go Back
            </button>
          </>
        )}
      </div>
    </main>
  );
}

export default function IntegrationsCallbackPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen flex items-center justify-center">
          <p className="text-[var(--muted)]">Loading…</p>
        </main>
      }
    >
      <CallbackHandler />
    </Suspense>
  );
}
