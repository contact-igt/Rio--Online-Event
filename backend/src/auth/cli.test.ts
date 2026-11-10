import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseAdapter, Dialect } from "../db/adapter.ts";
import { testEnvironment } from "../db/guards.ts";
import { openSqlite } from "../db/sqlite.ts";
import { dialects, openTestDatabase } from "../db/test-db.ts";
import { dropAppSchema, installAppSchema } from "../db/test-schema.ts";
import { runStaffCli } from "./cli-core.ts";
import { verifyPassword } from "./password.ts";

// The bootstrap command against a real database. The password it prints is the only place the temporary password ever appears.

const TRACKING = "zz_cli_migrations";
const folder = mkdtempSync(join(tmpdir(), "rio-cli-"));
const sqlitePath = join(folder, "cli.test.sqlite");
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const cheap = { ARGON2_MEMORY_KIB: "1024", ARGON2_PASSES: "1" };
const run = async (env: Record<string, string | undefined>, ...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runStaffCli(argv, { env, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err, text: [...out, ...err].join("\n") };
};
const passwordIn = (out: string[]) => /Temporary password \(shown once\): (\S+)/.exec(out.join("\n"))?.[1];

describe.each(dialects)("%s staff command line", (dialect: Dialect) => {
  let db: DatabaseAdapter;
  const env: Record<string, string | undefined> = dialect === "mysql" ? { ...testEnvironment(process.env), ...cheap } : { NODE_ENV: "test", DB_DIALECT: "sqlite", SQLITE_PATH: sqlitePath, ...cheap };

  beforeAll(async () => {
    db = dialect === "mysql" ? openTestDatabase("mysql") : openSqlite({ dialect: "sqlite", path: sqlitePath });
    await installAppSchema(db, TRACKING);
  }, 120_000);
  afterAll(async () => {
    await dropAppSchema(db, TRACKING);
    await db.close();
  });
  const count = async (sql: string, params: (string | number)[] = []) => Number((await db.query<{ n: number }>(sql, params)).rows[0]!.n);

  it("creates the first administrator with a random password that is shown once and stored only as a hash", async () => {
    const r = await run(env, "create-admin", "--email", "First.Admin@Example.org", "--name", "முதல் நிர்வாகி");
    expect(r.code).toBe(0);
    const password = passwordIn(r.out)!;
    expect(password).toMatch(/^[a-zA-Z2-9]{4}(-[a-zA-Z2-9]{4}){4}$/);
    expect(r.out.join("\n")).toContain("first.admin@example.org");
    const row = (await db.query<{ id: number; role: string; active: number; must_change_password: number; password_hash: string; display_name: string }>("SELECT * FROM staff_users WHERE email = 'first.admin@example.org'")).rows[0]!;
    expect(row).toMatchObject({ role: "admin", active: 1, must_change_password: 1, display_name: "முதல் நிர்வாகி" });
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(password, row.password_hash)).toBe(true);
    const audit = (await db.query("SELECT actor_type, actor_staff_id, action, entity_id, details FROM audit_log WHERE action = 'staff.created'")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: "system", actor_staff_id: null, entity_id: String(row.id) });
    const stored = JSON.stringify([(await db.query("SELECT * FROM staff_users")).rows, (await db.query("SELECT * FROM audit_log")).rows]);
    expect(stored).not.toContain(password);
  });

  it("refuses to create another administrator unless told to, and then does", async () => {
    const blocked = await run(env, "create-admin", "--email", "second@example.org", "--name", "Second");
    expect(blocked.code).toBe(1);
    expect(blocked.err.join(" ")).toContain("already exists");
    expect(await count("SELECT COUNT(*) AS n FROM staff_users WHERE email = 'second@example.org'")).toBe(0);
    const allowed = await run(env, "create-admin", "--email", "second@example.org", "--name", "Second", "--additional");
    expect(allowed.code).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM staff_users WHERE role = 'admin'")).toBe(2);
    const again = await run(env, "create-admin", "--email", "second@example.org", "--name", "Second", "--additional");
    expect(again.code).toBe(1);
    expect(again.text).toContain("already exists");
  });

  it.each([
    ["no command", []],
    ["an unknown command", ["delete-everything", "--email", "a@example.org"]],
    ["no e-mail", ["create-admin", "--name", "X"]],
    ["no name", ["create-admin", "--email", "a@example.org"]],
    ["an unknown flag", ["create-admin", "--email", "a@example.org", "--name", "X", "--password", "mine"]],
    ["an invalid e-mail", ["create-admin", "--email", "not-an-email", "--name", "X"]],
  ])("answers exit code 2 and the usage line for %s, and creates nothing", async (_label, argv) => {
    const before = await count("SELECT COUNT(*) AS n FROM staff_users");
    const r = await run(env, ...argv);
    expect(r.code).toBe(2);
    expect(r.out).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM staff_users")).toBe(before);
  });

  it("resets a password: new random one, forced change, all sessions ended, audited", async () => {
    const id = Number((await db.query<{ id: number }>("SELECT id FROM staff_users WHERE email = 'first.admin@example.org'")).rows[0]!.id);
    await db.query("UPDATE staff_users SET must_change_password = 0 WHERE id = ?", [id]);
    await db.query("INSERT INTO staff_sessions (staff_id, token_sha256, created_at, expires_at) VALUES (?, ?, ?, ?)", [id, "a".repeat(64), new Date(), new Date(Date.now() + 3_600_000)]);
    const r = await run(env, "reset-password", "--email", "FIRST.admin@example.org");
    expect(r.code).toBe(0);
    const password = passwordIn(r.out)!;
    const row = (await db.query<{ must_change_password: number; password_hash: string }>("SELECT must_change_password, password_hash FROM staff_users WHERE id = ?", [id])).rows[0]!;
    expect(Number(row.must_change_password)).toBe(1);
    expect(await verifyPassword(password, row.password_hash)).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM staff_sessions WHERE staff_id = ? AND revoked_at IS NULL", [id])).toBe(0);
    const audit = (await db.query("SELECT details FROM audit_log WHERE action = 'staff.password_reset'")).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(password);
  });

  it("says so when the account does not exist", async () => {
    const r = await run(env, "reset-password", "--email", "ghost@example.org");
    expect(r.code).toBe(1);
    expect(r.err.join(" ")).toContain("No staff account");
  });
});

describe("production safety", () => {
  const production = { NODE_ENV: "production", DB_DIALECT: "mysql", DATABASE_URL: "mysql://rio_app:s3cret-pass-word@db.internal:3306/rio_prod", DB_ALLOWED_HOST: "db.internal", ALLOWED_ORIGINS: "https://admin.example.org", ARGON2_MEMORY_KIB: "19456", ARGON2_PASSES: "2" };

  it("refuses to run in production unless the operator names the database, and never opens it or prints the connection string", async () => {
    let opened = false;
    const out: string[] = [];
    const err: string[] = [];
    const code = await runStaffCli(["create-admin", "--email", "a@example.org", "--name", "A"], { env: production, out: (l) => out.push(l), err: (l) => err.push(l) }, () => {
      opened = true;
      throw new Error("must not be opened");
    });
    expect(code).toBe(1);
    expect(opened).toBe(false);
    expect(err.join(" ")).toContain("RIO_CONFIRM_STAFF_CLI");
    expect([...out, ...err].join(" ")).not.toMatch(/s3cret|rio_app|db\.internal/);
  });

  it("refuses a wrong confirmation too", async () => {
    let opened = false;
    const code = await runStaffCli(["reset-password", "--email", "a@example.org"], { env: { ...production, RIO_CONFIRM_STAFF_CLI: "some_other_db" }, out: () => undefined, err: () => undefined }, () => {
      opened = true;
      throw new Error("must not be opened");
    });
    expect(code).toBe(1);
    expect(opened).toBe(false);
  });

  it("reports a configuration problem by variable name without echoing the value", async () => {
    const err: string[] = [];
    const code = await runStaffCli(["create-admin", "--email", "a@example.org", "--name", "A"], { env: { ...production, ALLOWED_ORIGINS: "http://not-https.example.org", RIO_CONFIRM_STAFF_CLI: "rio_prod" }, out: () => undefined, err: (l) => err.push(l) });
    expect(code).toBe(1);
    expect(err.join(" ")).toContain("ALLOWED_ORIGINS");
    expect(err.join(" ")).not.toContain("not-https");
  });

  it("refuses when no database is configured", async () => {
    const err: string[] = [];
    const code = await runStaffCli(["create-admin", "--email", "a@example.org", "--name", "A"], { env: { NODE_ENV: "development" }, out: () => undefined, err: (l) => err.push(l) });
    expect(code).toBe(1);
    expect(err.join(" ")).toContain("No database is configured");
  });
});
