import type { CookieOptions, Request, RequestHandler, Response } from "express";
import type { AuthConfig } from "../config.ts";
import { AppError } from "../http/errors.ts";
import { findSession, type StaffRole, type StaffSession } from "./sessions.ts";
import type { AuthDeps } from "./staff.ts";
import { csrfFor, sameText } from "./tokens.ts";

// The three checks in front of every staff route, in this order: where the request came from (Origin), who is making it (the session
// cookie, looked up in the database on every request), and whether the page that made it is ours (the CSRF header). Reading routes skip the
// first and last: they change nothing, and a response is only readable by an allowed origin (see cors.ts).

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export const cookieName = (auth: AuthConfig): string => (auth.cookieSecure ? "__Host-rio_staff" : "rio_staff");

export function cookieOptions(auth: AuthConfig): CookieOptions {
  // Host-only (no Domain) and Path=/ are what the __Host- prefix requires, and they keep the cookie from being shared with sibling sites.
  return { httpOnly: true, secure: auth.cookieSecure, sameSite: auth.cookieSameSite, path: "/" };
}

export function readToken(req: Request, auth: AuthConfig): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const name = cookieName(auth);
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function setSessionCookie(res: Response, auth: AuthConfig, token: string, expiresAt: Date, now: Date): void {
  res.cookie(cookieName(auth), token, { ...cookieOptions(auth), maxAge: Math.max(0, expiresAt.getTime() - now.getTime()) });
}
export function clearSessionCookie(res: Response, auth: AuthConfig): void {
  res.clearCookie(cookieName(auth), cookieOptions(auth));
}

/** Refuses a state-changing request whose Origin header is missing or not in the list. Reading requests are not checked. */
export function originGuardFor(origins: readonly string[]): RequestHandler {
  const allowed = new Set(origins);
  return (req, _res, next) => {
    if (SAFE.has(req.method)) return next();
    const origin = req.get("origin");
    if (origin === undefined || !allowed.has(origin)) return next(new AppError(403, "origin_not_allowed", "This request did not come from an allowed site."));
    next();
  };
}

export const originGuard = (auth: AuthConfig): RequestHandler => originGuardFor(auth.allowedOrigins);

export const staffOf = (res: Response): StaffSession => res.locals.staff as StaffSession;

export type RequireOptions = {
  /** Roles that may use the route. Omit for any signed-in member. */
  roles?: readonly StaffRole[];
  /** The few routes a member who must still choose a password may use (see me, password, logout). */
  allowPasswordChange?: boolean;
};

/**
 * Requires a valid session. Puts the member in `res.locals.staff`. The role comes from the database row, never from the request.
 * A different role gets the same 403 whatever the route is, so the answer does not describe what exists.
 */
export function requireStaff(deps: AuthDeps, options: RequireOptions = {}): RequestHandler[] {
  const authenticate: RequestHandler = async (req, res, next) => {
    const token = readToken(req, deps.auth);
    const session = token ? await findSession(deps.db, token, deps.now(), deps.auth.sessionIdleMs) : null;
    if (!session) {
      clearSessionCookie(res, deps.auth);
      return next(new AppError(401, "unauthenticated", "Sign in to continue."));
    }
    res.locals.staff = session;
    if (options.roles && !options.roles.includes(session.role)) return next(new AppError(403, "forbidden", "You are not allowed to do this."));
    if (session.mustChangePassword && !options.allowPasswordChange) return next(new AppError(403, "password_change_required", "Choose a new password to continue."));
    if (!SAFE.has(req.method)) {
      const given = req.get("x-csrf-token");
      if (given === undefined || !sameText(given, csrfFor(session.token))) return next(new AppError(403, "csrf_invalid", "The request could not be verified. Reload the page and try again."));
    }
    next();
  };
  return [originGuard(deps.auth), authenticate];
}
