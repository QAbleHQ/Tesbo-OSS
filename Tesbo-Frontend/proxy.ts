import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Session cookie is host-scoped to the API origin (api-app-stage.tesbo.io),
// not the frontend origin (app-stage.tesbo.io). Checking tesbo_session here
// 307s /projects -> /login while authMe() still sees a valid API session, so
// the login page stays on "Loading..." forever. Auth gating stays on the client.
export function proxy(_request: NextRequest) {
  return NextResponse.next();
}
