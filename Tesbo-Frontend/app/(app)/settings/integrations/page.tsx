"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function IntegrationsRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/settings?tab=integrations");
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-sm text-[var(--muted)]">Redirecting to workspace settings…</p>
    </div>
  );
}
