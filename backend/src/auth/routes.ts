import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { AppError } from "../http/errors.ts";
import { requestIdOf } from "../http/request-id.ts";
import { clearSessionCookie, originGuard, readToken, requireStaff, setSessionCookie, staffOf } from "./middleware.ts";
import { findSession } from "./sessions.ts";
import { changePassword, login, logout, publicStaff, RateLimited, WeakPassword, type AuthDeps } from "./staff.ts";
import { csrfFor, sameText } from "./tokens.ts";

// POST /login, POST /logout, GET /me, POST /password, mounted under /api/v1/staff. Bodies are JSON only and strict: an unexpected field
// (for example a "role") is a 400, never silently ignored.

const loginBody = z.strictObject({ email: z.string().max(254), password: z.string().min(1).max(256) });
const passwordBody = z.strictObject({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(512) });

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw new AppError(400, "invalid_request", "The request could not be understood.");
  return result.data;
}

/** Sends Retry-After with a 429, then lets the shared error handler write the body. */
const limited = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (error) {
    if (error instanceof RateLimited) res.set("Retry-After", String(error.retryAfterSeconds));
    if (error instanceof WeakPassword) {
      res.status(error.status).json({ error: { code: error.code, message: error.message, problems: error.problems, requestId: requestIdOf(res) } });
      return;
    }
    next(error);
  }
};

export function staffRouter(deps: AuthDeps): Router {
  const router = Router();
  const { auth } = deps;
  const body = (session: { token: string; expiresAt: Date }, staff: ReturnType<typeof publicStaff>) => ({ user: staff, csrfToken: csrfFor(session.token), expiresAt: session.expiresAt.toISOString() });

  router.post("/login", originGuard(auth), limited(async (req, res) => {
    const input = parse(loginBody, req.body);
    const result = await login(deps, { ...input, ip: req.ip ?? "unknown", requestId: requestIdOf(res), previousToken: readToken(req, auth) });
    setSessionCookie(res, auth, result.token, result.expiresAt, deps.now());
    res.status(200).json(body(result, result.staff));
  }));

  // Logout needs the session's CSRF token like any other change, but a request with no valid session is simply answered 204: there is nothing to end.
  router.post("/logout", originGuard(auth), limited(async (req, res) => {
    const token = readToken(req, auth);
    const session = token ? await findSession(deps.db, token, deps.now(), auth.sessionIdleMs) : null;
    if (session) {
      const given = req.get("x-csrf-token");
      if (given === undefined || !sameText(given, csrfFor(session.token))) throw new AppError(403, "csrf_invalid", "The request could not be verified. Reload the page and try again.");
      await logout(deps, session, requestIdOf(res));
    }
    clearSessionCookie(res, auth);
    res.status(204).end();
  }));

  router.get("/me", ...requireStaff(deps, { allowPasswordChange: true }), (_req, res) => {
    const session = staffOf(res);
    res.json({ ...body(session, publicStaff(session)), idleExpiresAt: session.idleExpiresAt.toISOString() });
  });

  router.post("/password", ...requireStaff(deps, { allowPasswordChange: true }), limited(async (req, res) => {
    const input = parse(passwordBody, req.body);
    const result = await changePassword(deps, staffOf(res), { ...input, requestId: requestIdOf(res) });
    setSessionCookie(res, auth, result.token, result.expiresAt, deps.now());
    res.status(200).json(body(result, result.staff));
  }));

  return router;
}
