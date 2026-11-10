import { Router } from "express";
import type { AppState } from "../app.ts";

// Liveness for Railway. It answers 503 once shutdown has begun so the platform stops sending traffic. It deliberately checks nothing
// else yet: there is no database connection in M1, and it never returns configuration or version details.
export function healthRouter(state: AppState): Router {
  const router = Router();
  router.get("/health", (_req, res) => {
    if (state.shuttingDown) {
      res.status(503).json({ status: "shutting_down" });
      return;
    }
    res.json({ status: "ok" });
  });
  return router;
}
