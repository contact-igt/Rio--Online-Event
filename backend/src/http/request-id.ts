import { randomUUID } from "node:crypto";
import type { RequestHandler, Response } from "express";

// Every response carries X-Request-Id. A caller-supplied id is kept only if it is a plain short token (so it cannot inject log lines or
// headers); anything else is replaced.
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const requestId: RequestHandler = (req, res, next) => {
  const given = req.get("x-request-id");
  const id = given !== undefined && SAFE_ID.test(given) ? given : randomUUID();
  res.locals.requestId = id;
  res.set("X-Request-Id", id);
  next();
};

export const requestIdOf = (res: Response): string => (typeof res.locals.requestId === "string" ? res.locals.requestId : "unknown");
