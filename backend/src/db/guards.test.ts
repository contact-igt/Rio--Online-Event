import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.ts";
import { assertMigrateAllowed, assertResetAllowed, GuardError, requireDatabase, testEnvironment } from "./guards.ts";

const mysqlEnv = (over: Record<string, string> = {}) => ({
  DB_DIALECT: "mysql",
  DATABASE_URL: "mysql://u:p@db.internal:3306/rio",
  DB_ALLOWED_HOST: "db.internal",
  ALLOWED_ORIGINS: "https://admin.example.org", // required by the config in production once a database is configured
  ...over,
});

describe("assertMigrateAllowed", () => {
  it("lets development and test migrate without confirmation", () => {
    expect(() => assertMigrateAllowed(loadConfig(mysqlEnv()), {})).not.toThrow();
  });

  it("in production demands the database name in RIO_CONFIRM_MIGRATE", () => {
    const config = loadConfig(mysqlEnv({ NODE_ENV: "production" }));
    expect(() => assertMigrateAllowed(config, {})).toThrow(GuardError);
    expect(() => assertMigrateAllowed(config, { RIO_CONFIRM_MIGRATE: "yes" })).toThrow(GuardError);
    expect(() => assertMigrateAllowed(config, { RIO_CONFIRM_MIGRATE: "rio" })).not.toThrow();
  });

  it("refuses to run with no database configured", () => {
    expect(() => requireDatabase(loadConfig({}))).toThrow(/No database is configured/);
  });
});

describe("assertResetAllowed", () => {
  const test = { NODE_ENV: "test", DB_DIALECT: "mysql", DATABASE_URL: "mysql://u:p@127.0.0.1:3306/rio_test", DB_ALLOWED_HOST: "127.0.0.1" };

  it("allows a local *_test MySQL database and an in-memory or .test.sqlite SQLite one under NODE_ENV=test", () => {
    expect(assertResetAllowed(loadConfig(test)).dialect).toBe("mysql");
    expect(assertResetAllowed(loadConfig({ NODE_ENV: "test", DB_DIALECT: "sqlite", SQLITE_PATH: ":memory:" })).dialect).toBe("sqlite");
    expect(assertResetAllowed(loadConfig({ NODE_ENV: "test", DB_DIALECT: "sqlite", SQLITE_PATH: "./data/x.test.sqlite" })).dialect).toBe("sqlite");
  });

  it("refuses outside NODE_ENV=test, even for a database that looks harmless", () => {
    expect(() => assertResetAllowed(loadConfig(mysqlEnv()))).toThrow(GuardError);
    expect(() => assertResetAllowed(loadConfig({ NODE_ENV: "development", DB_DIALECT: "sqlite", SQLITE_PATH: "./data/dev.sqlite" }))).toThrow(GuardError);
  });
});

describe("testEnvironment", () => {
  it("reads only RIO_TEST_* names, never DATABASE_URL", () => {
    const env = testEnvironment({ DATABASE_URL: "mysql://prod:secret@prod.example/rio", DB_DIALECT: "mysql" });
    expect(env).toEqual({ NODE_ENV: "test", DB_DIALECT: "sqlite", SQLITE_PATH: ":memory:" });
    expect(JSON.stringify(env)).not.toContain("prod");
  });

  it("builds a MySQL test target from RIO_TEST_DATABASE_URL, defaulting the allowed host to the loopback address", () => {
    const env = testEnvironment({ RIO_TEST_DATABASE_URL: "mysql://u:p@127.0.0.1:33306/rio_test" });
    expect(loadConfig(env).database).toMatchObject({ dialect: "mysql", host: "127.0.0.1", port: 33306, database: "rio_test" });
  });

  it("cannot be turned into a production target: a remote or non-test database is rejected by the config rules", () => {
    expect(() => loadConfig(testEnvironment({ RIO_TEST_DATABASE_URL: "mysql://u:p@prod.example:3306/rio_test", RIO_TEST_DB_ALLOWED_HOST: "prod.example" }))).toThrow(/local database/);
    expect(() => loadConfig(testEnvironment({ RIO_TEST_DATABASE_URL: "mysql://u:p@127.0.0.1:3306/rio" }))).toThrow(/_test/);
  });
});
