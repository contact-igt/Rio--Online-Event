import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

// The real `node src/db/cli.ts ...` command, run as a child process against a throw-away SQLite file (no database server needed).
// It pins the promises the local-development workflow relies on: status and ready only READ, migrate builds the schema, ready then says so.

const folder = mkdtempSync(join(tmpdir(), "rio-cli-cmd-"));
const sqlitePath = join(folder, "cmd.test.sqlite");
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const cli = join(import.meta.dirname, "cli.ts");
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", DB_DIALECT: "sqlite", SQLITE_PATH: sqlitePath }, encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const tables = (): string[] => {
  try {
    const db = new DatabaseSync(sqlitePath, { readOnly: true });
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    db.close();
    return names;
  } catch {
    return []; // the file does not exist yet
  }
};

describe("db:status and db:ready on a database nobody has touched", () => {
  it("db:status reports every migration as pending and writes nothing: not even the tracking table", () => {
    const r = run("status");
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toHaveLength(11);
    expect(r.out.split("\n").every((line) => line.endsWith("pending"))).toBe(true);
    expect(tables()).toEqual([]);
  });

  it("db:ready says the migrations are missing, exits 1, and writes nothing", () => {
    const r = run("ready");
    expect(r.code).toBe(1);
    expect(r.out).toBe("not ready: migrations_missing");
    expect(tables()).toEqual([]);
  });
});

describe("after db:migrate", () => {
  it("applies every migration and db:status and db:ready agree", () => {
    const m = run("migrate");
    expect(m.code).toBe(0);
    expect(m.out).toBe("Applied: 0001, 0002, 0003, 0004, 0005, 0006, 0007, 0008, 0009, 0010, 0011");
    expect(run("status").out.split("\n").every((line) => line.endsWith("applied"))).toBe(true);
    const ready = run("ready");
    expect(ready.code).toBe(0);
    expect(ready.out).toContain("ready:");
    expect(run("migrate").out).toBe("Nothing to apply.");
  });

  it("created the 18 application tables and the tracking table (and no other)", () => {
    const names = tables();
    expect(names).toHaveLength(19);
    expect(names).toEqual(expect.arrayContaining(["rio_migrations", "staff_users", "staff_sessions", "submissions", "registration_recovery", "audit_log", "rate_limits"]));
  });

  it("db:ready says pending when a migration file is newer than the database, without applying it", () => {
    const db = new DatabaseSync(sqlitePath);
    db.exec("DELETE FROM rio_migrations WHERE version = '0011'");
    db.close();
    const r = run("ready");
    expect(r.code).toBe(1);
    expect(r.out).toBe("not ready: migrations_pending");
    const db2 = new DatabaseSync(sqlitePath, { readOnly: true });
    expect((db2.prepare("SELECT COUNT(*) AS n FROM rio_migrations").get() as { n: number }).n).toBe(10); // still not applied
    db2.close();
  });
});

describe("the usage line", () => {
  it("lists the commands and exits 2 for an unknown one", () => {
    const r = execFileSync(process.execPath, ["--version"], { encoding: "utf8" });
    expect(r).toMatch(/^v24\./);
    const bad = run("destroy-everything");
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("db:ready");
  });
});
