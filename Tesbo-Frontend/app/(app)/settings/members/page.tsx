"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function MembersRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/settings?tab=members");
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-sm text-[var(--muted)]">Redirecting to workspace settings…</p>
    </div>
  );
}
