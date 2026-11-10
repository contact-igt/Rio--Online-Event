import { randomBytes } from "node:crypto";
import { loadConfig } from "../config.ts";
import type { DatabaseAdapter, Dialect } from "./adapter.ts";
import { testEnvironment } from "./guards.ts";
import { openDatabase } from "./open.ts";

// Test support only (excluded from the build). Tests reach a database only through loadConfig(), so the same rules that protect the app
// apply here: a MySQL test database must be local and named *_test, and only RIO_TEST_* variables are read, never DATABASE_URL.

const mysqlConfigured = Boolean(process.env.RIO_TEST_DATABASE_URL);
/** CI, or an explicit opt-in, makes the MySQL tests mandatory: a missing database fails the run instead of skipping. */
export const mysqlRequired = process.env.CI === "true" || process.env.RIO_REQUIRE_MYSQL_TESTS === "yes";

export const dialects: Dialect[] = mysqlConfigured ? ["sqlite", "mysql"] : ["sqlite"];

// Never let a SQLite-only run pass for a MySQL or MariaDB run: say so in the output, once per test file.
if (!mysqlConfigured) process.stderr.write("[rio] MySQL/MariaDB integration tests were NOT RUN: RIO_TEST_DATABASE_URL is not set. These results cover SQLite only.\n");
else process.stderr.write(`[rio] MySQL-protocol tests run against a ${process.env.RIO_TEST_DB_ENGINE === "mariadb" ? "MariaDB" : "MySQL 8"} test database (RIO_TEST_DB_ENGINE).\n`);

export function openTestDatabase(dialect: Dialect): DatabaseAdapter {
  const env = dialect === "mysql" ? testEnvironment(process.env) : { NODE_ENV: "test", DB_DIALECT: "sqlite", SQLITE_PATH: ":memory:" };
  const { database } = loadConfig(env);
  if (!database || database.dialect !== dialect) throw new Error(`No ${dialect} test database is configured.`);
  return openDatabase(database);
}

/** A table-name prefix unique to one test run, so parallel files and re-runs never collide in a shared MySQL test database. */
export const uniquePrefix = (): string => `zz_${randomBytes(4).toString("hex")}`;

export async function dropTables(db: DatabaseAdapter, names: string[]): Promise<void> {
  await db.withConnection(async (c) => {
    if (db.dialect === "mysql") await c.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const name of names) await c.query(`DROP TABLE IF EXISTS ${name}`);
    if (db.dialect === "mysql") await c.query("SET FOREIGN_KEY_CHECKS = 1");
  });
}
