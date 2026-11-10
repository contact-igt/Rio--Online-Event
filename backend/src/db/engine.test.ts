import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig, type DatabaseConfig } from "../config.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { assertEngineMatches, engineOfVersion, migrationFolder } from "./engine.ts";
import { sanitizeDatabaseError } from "./errors.ts";
import { GuardError, testEnvironment } from "./guards.ts";
import { checkParity } from "./migrate.ts";
import { migrationsDir } from "./test-schema.ts";

// Everything about running against XAMPP's MariaDB that can be proven without a database server.

const mysqlEnv = (over: Record<string, string> = {}) => ({ NODE_ENV: "development", DB_DIALECT: "mysql", DATABASE_URL: "mysql://rio_app:s3cret-pw@127.0.0.1:3306/rio_hospital", DB_ALLOWED_HOST: "127.0.0.1", ...over });
const databaseOf = (env: Record<string, string>): DatabaseConfig => loadConfig(env).database!;
const fakeServer = (version: string): DatabaseAdapter => ({ query: async () => ({ rows: [{ v: version }], affectedRows: 0 }) }) as unknown as DatabaseAdapter;

describe("DB_ENGINE", () => {
  it("defaults to mysql, accepts mariadb for local development, and picks the matching migration folder", () => {
    expect(databaseOf(mysqlEnv())).toMatchObject({ dialect: "mysql", engine: "mysql" });
    expect(databaseOf(mysqlEnv({ DB_ENGINE: "mariadb" }))).toMatchObject({ dialect: "mysql", engine: "mariadb" });
    expect(migrationFolder(databaseOf(mysqlEnv()))).toBe("mysql");
    expect(migrationFolder(databaseOf(mysqlEnv({ DB_ENGINE: "mariadb" })))).toBe("mariadb");
    expect(migrationFolder(databaseOf({ NODE_ENV: "development", DB_DIALECT: "sqlite", SQLITE_PATH: "./x.sqlite" }))).toBe("sqlite");
  });

  it.each([
    [{ DB_ENGINE: "postgres" }, "DB_ENGINE"],
    [{ DB_ENGINE: "mariadb", NODE_ENV: "production", DATABASE_URL: "mysql://u:p@db.internal:3306/rio", DB_ALLOWED_HOST: "db.internal", ALLOWED_ORIGINS: "https://admin.example.org" }, "refused in production"],
  ])("refuses %j", (over, text) => {
    expect(() => loadConfig(mysqlEnv(over))).toThrow(text);
  });

  it("refuses DB_ENGINE for a SQLite database, where it would mean nothing", () => {
    expect(() => loadConfig({ NODE_ENV: "development", DB_DIALECT: "sqlite", SQLITE_PATH: "./x.sqlite", DB_ENGINE: "mariadb" })).toThrow("DB_ENGINE");
  });

  it("passes the engine to the test environment, only for a MySQL-protocol test database", () => {
    expect(testEnvironment({ RIO_TEST_DATABASE_URL: "mysql://u:p@127.0.0.1:3306/rio_test", RIO_TEST_DB_ENGINE: "mariadb" })).toMatchObject({ DB_DIALECT: "mysql", DB_ENGINE: "mariadb" });
    expect(testEnvironment({ RIO_TEST_DATABASE_URL: "mysql://u:p@127.0.0.1:3306/rio_test" })).not.toHaveProperty("DB_ENGINE");
    expect(testEnvironment({ RIO_TEST_DB_ENGINE: "mariadb" })).not.toHaveProperty("DB_ENGINE"); // SQLite run
    expect(loadConfig(testEnvironment({ RIO_TEST_DATABASE_URL: "mysql://u:p@127.0.0.1:3306/rio_test", RIO_TEST_DB_ENGINE: "mariadb" })).database).toMatchObject({ engine: "mariadb" });
  });
});

describe("telling the two servers apart", () => {
  it.each([
    ["10.4.32-MariaDB", "mariadb"],
    ["10.11.6-MariaDB-log", "mariadb"],
    ["5.5.5-10.4.32-MariaDB", "mariadb"],
    ["8.0.46", "mysql"],
    ["8.4.0-commercial", "mysql"],
  ])("reads %s as %s", (version, engine) => {
    expect(engineOfVersion(version)).toBe(engine);
  });

  it("accepts a server that matches DB_ENGINE", async () => {
    await expect(assertEngineMatches(fakeServer("10.4.32-MariaDB"), databaseOf(mysqlEnv({ DB_ENGINE: "mariadb" })))).resolves.toBeUndefined();
    await expect(assertEngineMatches(fakeServer("8.0.46"), databaseOf(mysqlEnv()))).resolves.toBeUndefined();
    await expect(assertEngineMatches(fakeServer("anything"), databaseOf({ NODE_ENV: "development", DB_DIALECT: "sqlite", SQLITE_PATH: "./x.sqlite" }))).resolves.toBeUndefined();
  });

  it("refuses MariaDB when MySQL 8 was configured (the default), and the reverse, with fixed sentences", async () => {
    const wrongOne = await assertEngineMatches(fakeServer("10.4.32-MariaDB"), databaseOf(mysqlEnv())).catch((e: unknown) => e);
    expect(wrongOne).toBeInstanceOf(GuardError);
    expect((wrongOne as Error).message).toContain("DB_ENGINE=mariadb");
    const wrongTwo = await assertEngineMatches(fakeServer("8.0.46"), databaseOf(mysqlEnv({ DB_ENGINE: "mariadb" }))).catch((e: unknown) => e);
    expect(wrongTwo).toBeInstanceOf(GuardError);
    expect((wrongTwo as Error).message).toContain("DB_ENGINE=mysql");
    for (const e of [wrongOne, wrongTwo]) expect((e as Error).message).not.toMatch(/10\.4|8\.0\.46|s3cret|rio_app|127\.0\.0\.1|rio_hospital/);
  });
});

describe("MariaDB error numbers", () => {
  it("reads a CHECK violation as a check on both servers (MySQL 8 says 3819, MariaDB says 4025)", () => {
    for (const errno of [3819, 4025]) expect(sanitizeDatabaseError("mysql", Object.assign(new Error("Constraint x failed for db.table"), { errno }))).toMatchObject({ kind: "constraint", constraint: "check" });
  });

  it("keeps the other numbers both servers share", () => {
    const kind = (errno: number) => sanitizeDatabaseError("mysql", Object.assign(new Error("x"), { errno }));
    expect(kind(1062)).toMatchObject({ constraint: "unique" });
    expect(kind(1452)).toMatchObject({ constraint: "foreign_key" });
    expect(kind(1451)).toMatchObject({ constraint: "foreign_key" });
    expect(kind(1644)).toMatchObject({ constraint: "rule" });
    expect(kind(1213)).toMatchObject({ kind: "deadlock", retryable: true });
  });
});

describe("the MariaDB migration folder", () => {
  const root = join(import.meta.dirname, "../../migrations");
  const names = (folder: string) => readdirSync(join(root, folder)).filter((f) => f.endsWith(".sql")).sort();
  const body = (folder: string, file: string) => readFileSync(join(root, folder, file), "utf8").replace(/\r\n/g, "\n");

  it("has the same migrations as the MySQL 8 folder, and the parity check covers it", async () => {
    expect(names("mariadb")).toEqual(names("mysql"));
    expect(await checkParity(root)).toEqual([]);
  });

  it("is the reviewed MySQL 8 text with only the two MySQL-8-only collation names replaced (plus a header)", () => {
    for (const file of names("mysql")) {
      const expected = body("mysql", file).replace(/utf8mb4_0900_bin/g, "utf8mb4_nopad_bin").replace(/utf8mb4_0900_ai_ci/g, "utf8mb4_unicode_ci");
      const actual = body("mariadb", file);
      const header = actual.slice(0, actual.length - expected.length);
      expect(actual.endsWith(expected), file).toBe(true);
      expect(header.split("\n").filter(Boolean).every((l) => l.startsWith("--")), file).toBe(true);
      expect(expected, file).not.toContain("0900"); // none of the MySQL-8-only names is left in the SQL itself
    }
  });

  it("keeps the exact, no-padding comparison for every key, code, digest and normalised name", () => {
    for (const file of names("mariadb")) {
      for (const line of body("mariadb", file).split("\n")) {
        if (/\b(token_sha256|key_sha256|entry_code|child_name_norm|guardian_mobile|object_key|slug|email|question_key)\b.*(VARCHAR|CHAR)\(/.test(line) && !line.trim().startsWith("--")) {
          expect(line, `${file}: ${line.trim()}`).toContain("utf8mb4_nopad_bin");
        }
      }
    }
  });

  it("is picked by the test helpers only when RIO_TEST_DB_ENGINE=mariadb", () => {
    const before = process.env.RIO_TEST_DB_ENGINE;
    try {
      delete process.env.RIO_TEST_DB_ENGINE;
      expect(migrationsDir("mysql")).toMatch(/migrations[\\/]mysql$/);
      expect(migrationsDir("sqlite")).toMatch(/migrations[\\/]sqlite$/);
      process.env.RIO_TEST_DB_ENGINE = "mariadb";
      expect(migrationsDir("mysql")).toMatch(/migrations[\\/]mariadb$/);
      expect(migrationsDir("sqlite")).toMatch(/migrations[\\/]sqlite$/); // SQLite never follows it
    } finally {
      if (before === undefined) delete process.env.RIO_TEST_DB_ENGINE;
      else process.env.RIO_TEST_DB_ENGINE = before;
    }
  });
});

describe("checkParity with an optional third folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "rio-parity-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const make = (name: string, folders: Record<string, string[]>) => {
    const root = join(dir, name);
    for (const [folder, files] of Object.entries(folders)) {
      mkdirSync(join(root, folder), { recursive: true });
      for (const f of files) writeFileSync(join(root, folder, f), "SELECT 1");
    }
    return root;
  };

  it("ignores a missing mariadb folder", async () => {
    expect(await checkParity(make("two", { mysql: ["0001_a.sql"], sqlite: ["0001_a.sql"] }))).toEqual([]);
  });

  it("lists every difference against the MySQL 8 reference, naming the folder", async () => {
    const root = make("three", { mysql: ["0001_a.sql", "0002_b.sql"], sqlite: ["0001_a.sql", "0002_b.sql"], mariadb: ["0001_a.sql", "0003_c.sql"] });
    expect(await checkParity(root)).toEqual(["0002_b exists for mysql but not for mariadb", "0003_c exists for mariadb but not for mysql"]);
  });
});
