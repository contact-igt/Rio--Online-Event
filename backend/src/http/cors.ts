import type { RequestHandler } from "express";

// Cross-origin access for the admin site only. A browser on any other origin gets no CORS headers, so it can neither read a response nor
// send a request with credentials that the server would act on (state-changing routes also require an allowed Origin and a CSRF token).
// The answer is never "*": credentials and a wildcard are not allowed together, and a wildcard would be wrong anyway.

export function cors(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    res.vary("Origin");
    const origin = req.get("origin");
    if (origin === undefined || !allowed.has(origin)) return next();
    res.set({
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Expose-Headers": "X-Request-Id, Retry-After",
    });
    if (req.method === "OPTIONS" && req.get("access-control-request-method") !== undefined) {
      res.set({
        "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token",
        "Access-Control-Max-Age": "600",
      });
      res.status(204).end();
      return;
    }
    next();
  };
}
