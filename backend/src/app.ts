import express, { type Express } from "express";
import type { Config } from "./config.ts";
import { authDeps, type AuthDeps } from "./auth/staff.ts";
import { staffRouter } from "./auth/routes.ts";
import type { DatabaseAdapter } from "./db/adapter.ts";
import { cors } from "./http/cors.ts";
import { registrationRouter } from "./registration/routes.ts";
import { registrationDeps } from "./registration/service.ts";
import type { Logger } from "./logger.ts";
import { errorHandler, notFoundHandler } from "./http/errors.ts";
import { healthRouter } from "./http/health.ts";
import { requestId, requestIdOf } from "./http/request-id.ts";
import { securityHeaders } from "./http/security-headers.ts";

export type AppState = { shuttingDown: boolean };

export type AppDeps = {
  config: Config;
  logger: Logger;
  state: AppState;
  /** The opened database. Without it only the health route exists: staff routes are mounted only when there is somewhere to keep sessions. */
  db?: DatabaseAdapter;
  now?: () => Date;
  /** Where later modules (and tests) attach their own routes; they receive the same authentication dependencies the staff routes use. */
  mount?: (app: Express, auth: AuthDeps) => void;
};

export function createApp(deps: AppDeps): Express {
  const { config, logger, state } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  // Behind Railway the socket peer is the proxy; the number of trusted hops makes req.ip the real client, which the login rate limit needs.
  if (config.auth.trustProxyHops > 0) app.set("trust proxy", config.auth.trustProxyHops);

  app.use(requestId);
  app.use(securityHeaders({ production: config.env === "production" }));
  // Browsers may read answers only from the admin site and the public website; each group of routes also enforces its own origin list.
  app.use(cors([...config.auth.allowedOrigins, ...config.registration.publicOrigins]));
  app.use((_req, res, next) => {
    if (state.shuttingDown) res.set("Connection", "close"); // do not keep connections open while draining
    next();
  });
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      // Path only: a query string can carry personal data.
      logger.info("request", {
        requestId: requestIdOf(res),
        method: req.method,
        path: req.originalUrl.split("?")[0],
        status: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
      });
    });
    next();
  });
  // JSON only, with a hard size limit. There is no form or multipart parser; videos go straight to R2, never through this server.
  app.use(express.json({ limit: config.bodyLimitBytes, strict: true }));

  app.use("/api/v1", healthRouter(state));
  if (deps.db) {
    const auth = authDeps(deps.db, config.auth, deps.now);
    app.use("/api/v1/staff", staffRouter(auth));
    app.use("/api/v1", registrationRouter(registrationDeps(deps.db, config, deps.now)));
    deps.mount?.(app, auth);
  }

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
