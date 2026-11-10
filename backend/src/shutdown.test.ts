import express from "express";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { AppState } from "./app.ts";
import { createShutdown } from "./shutdown.ts";
import { captureLogger, listen } from "./test-helpers.ts";

function setup(timeoutMs: number, onClosed?: () => Promise<void>) {
  const { lines, logger } = captureLogger();
  const state: AppState = { shuttingDown: false };
  const app = express();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const hasStarted = new Promise<void>((r) => (started = r));
  app.get("/slow", async (_req, res) => {
    started();
    await gate;
    res.json({ done: true });
  });
  app.get("/hang", () => started()); // never answers
  const server = createServer(app);
  const shutdown = createShutdown({ server, state, logger, timeoutMs, ...(onClosed ? { onClosed } : {}) });
  return { server, state, lines, shutdown, release, hasStarted };
}

describe("graceful shutdown", () => {
  it("lets an in-flight request finish, then closes and refuses new connections", async () => {
    const { server, state, shutdown, release, hasStarted, lines } = setup(5000);
    const base = await listen(server);
    const inFlight = fetch(`${base}/slow`);
    await hasStarted;

    const closing = shutdown("SIGTERM");
    expect(state.shuttingDown).toBe(true);
    release();
    const res = await inFlight;
    expect(await res.json()).toEqual({ done: true });
    expect(await closing).toBe("closed");
    await expect(fetch(`${base}/slow`)).rejects.toThrow();
    expect(lines.map((l) => JSON.parse(l).message)).toEqual(["shutdown_started", "shutdown_complete"]);
  });

  it("cuts a connection that outlives the timeout and reports it as forced", async () => {
    const { server, shutdown, hasStarted, lines } = setup(100);
    const base = await listen(server);
    const hung = fetch(`${base}/hang`).catch(() => "cut");
    await hasStarted;
    expect(await shutdown("SIGTERM")).toBe("forced");
    expect(await hung).toBe("cut");
    expect(lines.map((l) => JSON.parse(l).message)).toContain("shutdown_forced");
  });

  it("runs the cleanup hook once after the server closed, even if shutdown is requested twice", async () => {
    const onClosed = vi.fn(async () => {});
    const { server, shutdown } = setup(1000, onClosed);
    await listen(server);
    const first = shutdown("SIGTERM");
    const second = shutdown("SIGINT");
    expect(second).toBe(first);
    await first;
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("still completes, and logs only the error type, when the cleanup hook fails", async () => {
    const { server, shutdown, lines } = setup(1000, async () => {
      throw new Error("mysql://root:hunter2@h/db refused");
    });
    await listen(server);
    expect(await shutdown("SIGTERM")).toBe("closed");
    const text = lines.join("\n");
    expect(text).toContain("shutdown_cleanup_failed");
    expect(text).not.toContain("hunter2");
  });
});
