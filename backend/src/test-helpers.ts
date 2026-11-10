import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, type AppState } from "./app.ts";
import { loadConfig, type Config } from "./config.ts";
import { createLogger } from "./logger.ts";

// Shared by tests only (excluded from the production build by tsconfig.build.json).

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ NODE_ENV: "test", ...env });
}

export function captureLogger(level: "debug" | "info" | "warn" | "error" = "debug") {
  const lines: string[] = [];
  return { lines, logger: createLogger({ level, write: (line) => lines.push(line) }) };
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export function startedApp(env: Record<string, string> = {}) {
  const { lines, logger } = captureLogger();
  const state: AppState = { shuttingDown: false };
  return { lines, state, app: createApp({ config: testConfig(env), logger, state }) };
}
