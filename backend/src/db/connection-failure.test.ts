import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.ts";
import { DatabaseError } from "./errors.ts";
import { openDatabase } from "./open.ts";
import { captureLogger } from "../test-helpers.ts";

// Needs no running database: port 1 on the loopback address refuses connections immediately.
const PASSWORD = "Sup3r-Secret-pw";
const config = (over: Record<string, string> = {}) =>
  loadConfig({ NODE_ENV: "test", DB_DIALECT: "mysql", DATABASE_URL: `mysql://app_user:${PASSWORD}@127.0.0.1:1/rio_test`, DB_ALLOWED_HOST: "127.0.0.1", DB_CONNECT_TIMEOUT_SECONDS: "1", ...over });

describe("MySQL connection failure", () => {
  it("creating the adapter does not connect, and does not throw", () => {
    const db = openDatabase(config().database!);
    expect(db.dialect).toBe("mysql");
    return db.close();
  });

  it("a refused connection becomes a sanitised `unavailable` error that leaks no host, user or password", async () => {
    const db = openDatabase(config().database!);
    const error = await db.ping().then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).toMatchObject({ kind: "unavailable", retryable: false });
    expect(`${inspect(error, { depth: 6 })}${JSON.stringify(error)}`).not.toMatch(new RegExp(`${PASSWORD}|app_user|127\\.0\\.0\\.1|rio_test`));
    await db.close();
  });

  it("the failure is reported the same way through transactions and the lock helper", async () => {
    const db = openDatabase(config().database!);
    for (const attempt of [() => db.transaction(async () => 1), () => db.withLock("x", async () => 1), () => db.withConnection(async () => 1)]) {
      expect(await attempt().then(() => undefined, (e: unknown) => e)).toMatchObject({ kind: "unavailable" });
    }
    await db.close();
  });

  it("logging the failure with the logger leaves no secret in the output", async () => {
    const { lines, logger } = captureLogger();
    const db = openDatabase(config().database!);
    await db.ping().catch((error: unknown) => logger.error("database_unavailable", { error }));
    expect(lines.join("")).toContain("unavailable");
    expect(lines.join("")).not.toContain(PASSWORD);
    await db.close();
  });
});

describe("SQLite open failure", () => {
  it("an unusable location becomes a sanitised error without the path", async () => {
    // A directory cannot be created inside a regular file, on any operating system.
    const dir = mkdtempSync(join(tmpdir(), "rio-sqlite-"));
    const file = join(dir, "plain-file");
    writeFileSync(file, "x");
    try {
      const db = openDatabase({ dialect: "sqlite", path: join(file, "sub", "x.sqlite") });
      const error = await db.ping().then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(DatabaseError);
      expect(inspect(error)).not.toContain("plain-file");
      await db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
