import type { ReactNode } from "react";
import Link from "next/link";
import { IconCheck } from "@tabler/icons-react";
import { BrandLogo } from "@/components/BrandLogo";

const FEATURES = [
  "Organize test cases & suites",
  "Track runs & results in real time",
  "Integrate with your CI/CD pipeline",
];

export function AuthSplitShell({ children }: { children: ReactNode }) {
  const year = new Date().getFullYear();

  return (
    <div className="dark flex min-h-screen w-full bg-[#0d0d1a]" style={{ colorScheme: "dark" }}>
      <div
        className="relative hidden w-full max-w-[440px] shrink-0 flex-col justify-between overflow-hidden border-r border-white/[0.06] px-10 py-12 lg:flex"
        style={{ background: "linear-gradient(145deg, #13132a 0%, #0d0d1a 100%)" }}
      >
        <div
          className="auth-orb-1 pointer-events-none absolute -left-16 -top-16 h-[280px] w-[280px] rounded-full"
          style={{ background: "radial-gradient(circle, rgba(123,110,224,.25) 0%, transparent 70%)" }}
        />
        <div
          className="auth-orb-2 pointer-events-none absolute -right-10 bottom-10 h-[200px] w-[200px] rounded-full"
          style={{ background: "radial-gradient(circle, rgba(123,110,224,.15) 0%, transparent 70%)" }}
        />
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.04]"
          viewBox="0 0 400 580"
          preserveAspectRatio="xMidYMid slice"
        >
          <defs>
            <pattern id="auth-hex" x="0" y="0" width="52" height="60" patternUnits="userSpaceOnUse">
              <polygon
                points="26,2 50,15 50,45 26,58 2,45 2,15"
                fill="none"
                stroke="#8b7ee8"
                strokeWidth="1"
              />
            </pattern>
          </defs>
          <rect width="400" height="580" fill="url(#auth-hex)" />
        </svg>

        <div className="relative z-10">
          <BrandLogo className="h-9 w-auto object-contain brightness-0 invert" />
        </div>

        <div className="relative z-10">
          <div className="mb-4 text-[26px] font-bold leading-tight tracking-tight text-white">
            Ship with
            <br />
            confidence.
          </div>
          <div className="mb-7 text-[13px] leading-relaxed text-white/45">
            End-to-end test management
            <br />
            for modern QA teams.
          </div>
          <ul className="flex flex-col gap-2.5">
            {FEATURES.map((feature) => (
              <li key={feature} className="flex items-center gap-2.5 text-[12px] text-white/50">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[rgba(123,110,224,.2)]">
                  <IconCheck size={11} stroke={2.5} className="text-[#8b7ee8]" />
                </span>
                {feature}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative z-10 text-[11px] text-white/20">
          © {year} Tesbo · <Link href="/privacy-policy" className="text-white/20 hover:text-white/40">Privacy</Link>{" "}
          · <Link href="/terms-and-conditions" className="text-white/20 hover:text-white/40">Terms</Link>
        </div>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center bg-[var(--background)] px-6 py-12">
        <div className="mb-8 lg:hidden">
          <BrandLogo className="h-9 w-auto object-contain brightness-0 invert" />
        </div>
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
