import type { Server } from "node:http";
import type { AppState } from "./app.ts";
import type { Logger } from "./logger.ts";

export type ShutdownResult = "closed" | "forced";

/**
 * Graceful shutdown: stop taking new connections, let requests in flight finish, then cut whatever is left after the timeout.
 * Calling it twice returns the same promise. `onClosed` is where database pools will be closed in a later module.
 */
export function createShutdown(options: {
  server: Server;
  state: AppState;
  logger: Logger;
  timeoutMs: number;
  onClosed?: () => Promise<void>;
}): (signal: string) => Promise<ShutdownResult> {
  const { server, state, logger, timeoutMs, onClosed } = options;
  let running: Promise<ShutdownResult> | null = null;

  return (signal) => {
    running ??= new Promise<ShutdownResult>((resolve) => {
      state.shuttingDown = true;
      logger.info("shutdown_started", { signal });
      let forced = false;
      const timer = setTimeout(() => {
        forced = true;
        logger.warn("shutdown_forced", { timeoutMs });
        server.closeAllConnections();
      }, timeoutMs);
      server.close(() => {
        clearTimeout(timer);
        void (onClosed?.() ?? Promise.resolve())
          .catch((error: unknown) => logger.error("shutdown_cleanup_failed", { error }))
          .finally(() => {
            logger.info("shutdown_complete", { forced });
            resolve(forced ? "forced" : "closed");
          });
      });
      server.closeIdleConnections();
    });
    return running;
  };
}
