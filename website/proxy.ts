import type { NextRequest } from "next/server";
import { refreshSession } from "@/lib/supabase/session-proxy";

export function proxy(request: NextRequest) {
  return refreshSession(request);
}

// Only the parent routes that use the session. The public landing and event pages stay fully static.
export const config = {
  matcher: ["/signin/:path*", "/account", "/events/:slug/register"],
};
