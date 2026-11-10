import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAMES } from "@/lib/api/express";
import { staffLoginPath } from "@/lib/staff/paths";

// A first, cheap gate: /admin and /judge need the session cookie to be present at all, otherwise the visitor goes to the sign-in without any
// page being rendered. The cookie is an opaque token, so this proves nothing: every page and action asks the Express API who the session
// belongs to (lib/staff/auth.ts) and that is the real check.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const guarded = pathname === "/admin" || pathname.startsWith("/admin/") || pathname === "/judge" || pathname.startsWith("/judge/");
  if (guarded && !SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name))) {
    return NextResponse.redirect(new URL(staffLoginPath, request.url));
  }
  const response = NextResponse.next();
  response.headers.set("cache-control", "no-store");
  return response;
}

export const config = {
  matcher: ["/admin/:path*", "/judge/:path*", "/staff/:path*"],
};
