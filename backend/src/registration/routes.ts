import { Router, type Request, type RequestHandler, type Response } from "express";
import { cookieOptions, originGuardFor } from "../auth/middleware.ts";
import { RateLimited } from "../auth/staff.ts";
import { sameText } from "../auth/tokens.ts";
import { AppError } from "../http/errors.ts";
import { requestIdOf } from "../http/request-id.ts";
import { codeCookieName } from "./cookie.ts";
import { registrationCsrf, showRecoveryCode } from "./codes.ts";
import { createBody, parseBody, patchBody, recoverBody, ValidationFailed } from "./schemas.ts";
import { createRegistration, findAccess, limit, listEvents, loadView, publicSettings, recover, REGISTRATION_LIMITS, updateRegistration, type Access, type RegistrationDeps } from "./service.ts";

// GET /events, GET /settings/public, POST /registrations, POST /registrations/recover, GET and PATCH /registrations/current, all under /api/v1.
// Public and unauthenticated: the only credential is the recovery code (HttpOnly cookie or typed). Every change needs an Origin from
// PUBLIC_ORIGINS; a change to an existing entry also needs the CSRF token that /current and every other response of this module returns.

const noEntry = () => new AppError(401, "no_registration", "Open your registration with your recovery code.");

/** Sends Retry-After with a 429 and the list of fields with a 422; every other error goes to the shared handler. */
const route = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (error) {
    if (error instanceof RateLimited) res.set("Retry-After", String(error.retryAfterSeconds));
    if (error instanceof ValidationFailed) {
      res.status(error.status).json({ error: { code: error.code, message: error.message, fields: error.fields, requestId: requestIdOf(res) } });
      return;
    }
    next(error);
  }
};

export function registrationRouter(deps: RegistrationDeps): Router {
  const router = Router();
  const { auth, registration } = deps.config;
  const origin = originGuardFor(registration.publicOrigins);
  const cookie = codeCookieName(auth);
  const ip = (req: Request) => req.ip ?? "unknown";

  const readCode = (req: Request): string | null => {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0 && part.slice(0, eq).trim() === cookie) return part.slice(eq + 1).trim();
    }
    return null;
  };
  const setCode = (res: Response, access: Access) => res.cookie(cookie, access.code, { ...cookieOptions(auth), maxAge: Math.max(0, access.expiresAt.getTime() - deps.now().getTime()) });
  const withSession = (access: Access) => ({ csrfToken: registrationCsrf(access.code) });

  router.get("/events", route(async (_req, res) => void res.json({ events: await listEvents(deps) })));
  router.get("/settings/public", route(async (_req, res) => void res.json(await publicSettings(deps))));

  router.post("/registrations", origin, route(async (req, res) => {
    await limit(deps, "registration.create.ip", ip(req), REGISTRATION_LIMITS.createPerIp);
    const input = parseBody(createBody, req.body);
    const created = await createRegistration(deps, input, { requestId: requestIdOf(res) });
    setCode(res, created.access);
    // The code is returned here once, in readable groups; afterwards only its digest exists on the server.
    res.status(201).json({
      reference: created.reference,
      recoveryCode: showRecoveryCode(created.access.code),
      ...withSession(created.access),
      registration: await loadView(deps.db, created.access),
    });
  }));

  router.post("/registrations/recover", origin, route(async (req, res) => {
    const { code } = parseBody(recoverBody, req.body);
    const access = await recover(deps, code, { ip: ip(req), requestId: requestIdOf(res) });
    setCode(res, access);
    res.json({ ...withSession(access), registration: await loadView(deps.db, access) });
  }));

  router.get("/registrations/current", route(async (req, res) => {
    await limit(deps, "registration.read.ip", ip(req), REGISTRATION_LIMITS.readPerIp);
    const access = await findAccess(deps, readCode(req));
    if (!access) {
      res.clearCookie(cookie, cookieOptions(auth));
      throw noEntry();
    }
    res.json({ ...withSession(access), registration: await loadView(deps.db, access) });
  }));

  router.patch("/registrations/current", origin, route(async (req, res) => {
    await limit(deps, "registration.read.ip", ip(req), REGISTRATION_LIMITS.readPerIp);
    const access = await findAccess(deps, readCode(req));
    if (!access) {
      res.clearCookie(cookie, cookieOptions(auth));
      throw noEntry();
    }
    const given = req.get("x-csrf-token");
    if (given === undefined || !sameText(given, registrationCsrf(access.code))) throw new AppError(403, "csrf_invalid", "The request could not be verified. Reload the page and try again.");
    const patch = parseBody(patchBody, req.body);
    res.json({ ...withSession(access), registration: await updateRegistration(deps, access, patch, { requestId: requestIdOf(res) }) });
  }));

  return router;
}
