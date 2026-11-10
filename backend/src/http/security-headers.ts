import type { RequestHandler } from "express";

// A JSON API: nothing it returns is ever a page, so the policy forbids everything, and nothing is cacheable.
export function securityHeaders(options: { production: boolean }): RequestHandler {
  return (_req, res, next) => {
    res.set({
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
      "Cross-Origin-Resource-Policy": "same-site",
      "Cache-Control": "no-store",
    });
    if (options.production) res.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
    next();
  };
}
