import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Must match AppConfigService.sessionCookieName in the backend.
const SESSION_COOKIE = "tesbo_session";

// Routes behind the authenticated app shell (Sidebar + TopBar), see app/(app)/layout.tsx.
// This is a fast, cookie-presence check to avoid rendering that shell before redirecting to
// /login when there's no session at all — the client-side authMe() check still runs after
// this and handles the slower case of a stale/expired cookie.
export function proxy(request: NextRequest) {
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  if (hasSession) return NextResponse.next();

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("redirect", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/projects/:path*", "/dashboard/:path*", "/activity/:path*", "/settings/:path*", "/account/:path*"],
};
