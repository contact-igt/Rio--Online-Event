import { describe, expect, it } from "vitest";
import { createLogger, redact, REDACTED } from "./logger.ts";

const run = (fields: Record<string, unknown>, message = "event") => {
  const lines: string[] = [];
  createLogger({ level: "debug", write: (l) => lines.push(l), now: () => new Date("2026-11-10T00:00:00Z") }).info(message, fields);
  return lines[0]!;
};

describe("logger", () => {
  it("writes one JSON object per line with time, level and message", () => {
    expect(JSON.parse(run({ a: 1 }))).toEqual({ time: "2026-11-10T00:00:00.000Z", level: "info", message: "event", a: 1 });
  });

  it("filters by level", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "warn", write: (l) => lines.push(l) });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map((l) => JSON.parse(l).level)).toEqual(["warn", "error"]);
  });

  it.each([
    "password",
    "newPassword",
    "SUPABASE_SECRET_KEY",
    "R2_SECRET_ACCESS_KEY",
    "Authorization",
    "cookie",
    "Set-Cookie",
    "sessionToken",
    "DATABASE_URL",
    "apiKey",
    "x-api-key",
    "otp",
    "email",
    "parent_email",
    "mobile",
    "childName",
    "signature",
  ])("redacts the value of a field named %s", (key) => {
    const out = run({ [key]: "SENSITIVE-VALUE" });
    expect(out).not.toContain("SENSITIVE-VALUE");
    expect(JSON.parse(out)[key]).toBe(REDACTED);
  });

  it("keeps harmless fields", () => {
    expect(JSON.parse(run({ requestId: "abc12345", status: 200, path: "/api/v1/health" }))).toMatchObject({ requestId: "abc12345", status: 200, path: "/api/v1/health" });
  });

  it("redacts nested values and arrays", () => {
    const out = run({ ctx: { user: { password: "p1" }, list: [{ token: "t1" }] } });
    expect(out).not.toMatch(/p1|t1/);
  });

  it("scrubs secrets that appear inside ordinary strings", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.c2lnbmF0dXJl";
    const out = run(
      { note: `connect mysql://admin:hunter2@db.example:3306/rio failed; Bearer abc.def.ghi; token ${jwt}; sb_secret_AbCd1234` },
      "failed with mysql://root:topsecret@h/db",
    );
    for (const leaked of ["hunter2", "admin:", "abc.def.ghi", jwt, "sb_secret_AbCd1234", "topsecret"]) expect(out).not.toContain(leaked);
    expect(out).toContain(REDACTED);
  });

  it("reduces an Error to its type, so user text inside the message is not logged", () => {
    const err = Object.assign(new TypeError("child Asha, mobile 9876543210"), { code: "E_X" });
    const out = run({ error: err });
    expect(out).not.toMatch(/Asha|9876543210/);
    expect(JSON.parse(out).error).toEqual({ name: "TypeError", code: "E_X" });
  });

  it("survives circular and very deep objects", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => run({ loop })).not.toThrow();
    expect(redact({ a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } })).toBeTruthy();
  });

  it("truncates very long strings", () => {
    expect(JSON.parse(run({ big: "x".repeat(5000) })).big).toHaveLength(500);
  });
});
