"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function ManageAdminsRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/settings?tab=admins");
  }, [router]);

  return (
    <div className="flex min-h-[200px] items-center justify-center">
      <p className="text-sm text-[var(--muted)]">Redirecting to workspace settings…</p>
    </div>
  );
}
