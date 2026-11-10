import express from "express";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { errorHandler, notFoundHandler, AppError } from "./http/errors.ts";
import { requestId } from "./http/request-id.ts";
import { captureLogger, listen, startedApp } from "./test-helpers.ts";

type ErrorBody = { error: { code: string; message: string; requestId: string } };
const errorBody = async (res: Response) => (await res.json()) as ErrorBody;

const servers: Server[] = [];
async function serve(app: express.Express): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  return listen(server);
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => (s.closeAllConnections(), s.close(r)))));
});

describe("GET /api/v1/health", () => {
  it("answers 200 with a minimal body and no configuration", async () => {
    const { app } = startedApp();
    const res = await fetch(`${await serve(app)}/api/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("answers 503 while shutting down and asks the client to close the connection", async () => {
    const { app, state } = startedApp();
    const base = await serve(app);
    state.shuttingDown = true;
    const res = await fetch(`${base}/api/v1/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "shutting_down" });
    expect(res.headers.get("connection")).toBe("close");
  });
});

describe("security headers", () => {
  it("are set on every response, including errors, and nothing identifies the framework", async () => {
    const base = await serve(startedApp().app);
    for (const path of ["/api/v1/health", "/api/v1/missing"]) {
      const res = await fetch(base + path);
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-powered-by")).toBeNull();
      expect(res.headers.get("strict-transport-security")).toBeNull(); // test mode: not production
    }
  });

  it("adds HSTS in production", async () => {
    const res = await fetch(`${await serve(startedApp({ NODE_ENV: "production" }).app)}/api/v1/health`);
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
  });
});

describe("request ids", () => {
  it("generates one per response and keeps a safe caller-supplied id", async () => {
    const base = await serve(startedApp().app);
    const a = await fetch(`${base}/api/v1/health`);
    const b = await fetch(`${base}/api/v1/health`);
    expect(a.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.headers.get("x-request-id")).not.toBe(b.headers.get("x-request-id"));
    const kept = await fetch(`${base}/api/v1/health`, { headers: { "x-request-id": "client-id_12345678" } });
    expect(kept.headers.get("x-request-id")).toBe("client-id_12345678");
  });

  it.each(["short", "has space in it!!", "x".repeat(65), "<script>alert(1)</script>"])("replaces the unsafe id %j", async (given) => {
    const base = await serve(startedApp().app);
    const res = await fetch(`${base}/api/v1/health`, { headers: { "x-request-id": given } });
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("appears in error bodies and in the request log line", async () => {
    const { app, lines } = startedApp();
    const res = await fetch(`${await serve(app)}/api/v1/nope`);
    const id = res.headers.get("x-request-id");
    expect((await errorBody(res)).error.requestId).toBe(id);
    expect(lines.some((l) => JSON.parse(l).requestId === id && JSON.parse(l).message === "request")).toBe(true);
  });
});

describe("error handling", () => {
  it("returns a uniform 404", async () => {
    const res = await fetch(`${await serve(startedApp().app)}/api/v1/unknown`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found.", requestId: res.headers.get("x-request-id") } });
  });

  it("rejects malformed JSON with 400 and no parser details", async () => {
    const res = await fetch(`${await serve(startedApp().app)}/api/v1/health`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":' });
    expect(res.status).toBe(400);
    const body = await errorBody(res);
    expect(body.error.code).toBe("bad_request");
    expect(JSON.stringify(body)).not.toMatch(/JSON|token|position/i);
  });

  it("rejects a body over the limit with 413", async () => {
    const res = await fetch(`${await serve(startedApp({ BODY_LIMIT_BYTES: "1024" }).app)}/api/v1/health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(2000) }),
    });
    expect(res.status).toBe(413);
    expect((await errorBody(res)).error.code).toBe("payload_too_large");
  });

  it("accepts a body under the limit (the unknown route then answers 404, not a parser error)", async () => {
    const res = await fetch(`${await serve(startedApp({ BODY_LIMIT_BYTES: "1024" }).app)}/api/v1/other`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });
    expect(res.status).toBe(404);
  });

  describe("the central handler", () => {
    const build = () => {
      const { lines, logger } = captureLogger();
      const app = express();
      app.use(requestId);
      app.get("/boom", () => {
        throw new Error("db password hunter2 for child Asha 9876543210");
      });
      app.get("/async-boom", async () => {
        throw new Error("async detail hunter2");
      });
      app.get("/known", () => {
        throw new AppError(409, "conflict", "Already exists.");
      });
      app.use(notFoundHandler);
      app.use(errorHandler(logger));
      return { app, lines };
    };

    it("hides the message and stack of unexpected errors (sync and async) and logs only the type", async () => {
      const { app, lines } = build();
      const base = await serve(app);
      for (const path of ["/boom", "/async-boom"]) {
        const res = await fetch(base + path);
        const text = await res.text();
        expect(res.status).toBe(500);
        expect(JSON.parse(text).error).toMatchObject({ code: "internal", message: "Something went wrong." });
        expect(text).not.toMatch(/hunter2|Asha|9876543210|at \w|\.ts/);
      }
      const logged = lines.join("\n");
      expect(logged).toContain("request_failed");
      expect(logged).not.toMatch(/hunter2|Asha|9876543210/);
    });

    it("passes a deliberate AppError through with its status and code", async () => {
      const res = await fetch(`${await serve(build().app)}/known`);
      expect(res.status).toBe(409);
      expect((await errorBody(res)).error).toMatchObject({ code: "conflict", message: "Already exists." });
    });
  });
});
