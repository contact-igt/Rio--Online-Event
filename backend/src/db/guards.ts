import type { Config, DatabaseConfig } from "../config.ts";

// Extra checks for the command-line tools. loadConfig() already refuses unsafe targets; these add the "are you sure" layer for the two
// commands that change a database.

export class GuardError extends Error {
  override name = "GuardError";
}

export function requireDatabase(config: Config): DatabaseConfig {
  if (!config.database) throw new GuardError("No database is configured (set DB_DIALECT and its settings).");
  return config.database;
}

const targetName = (db: DatabaseConfig): string => (db.dialect === "mysql" ? db.database : db.path);

/** In production a migration runs only when the operator types the database name into RIO_CONFIRM_MIGRATE for that one command. */
export function assertMigrateAllowed(config: Config, env: Record<string, string | undefined>): void {
  const db = requireDatabase(config);
  if (config.env === "production" && env.RIO_CONFIRM_MIGRATE !== targetName(db)) {
    throw new GuardError("Production migration needs RIO_CONFIRM_MIGRATE set to the database name for this command.");
  }
}

/** In production, creating or resetting a staff account needs the operator to type the database name into RIO_CONFIRM_STAFF_CLI for that one command. */
export function assertStaffCliAllowed(config: Config, env: Record<string, string | undefined>): void {
  const db = requireDatabase(config);
  if (config.env === "production" && env.RIO_CONFIRM_STAFF_CLI !== targetName(db)) {
    throw new GuardError("In production this command needs RIO_CONFIRM_STAFF_CLI set to the database name for this command.");
  }
}

/** Resetting drops every table, so it is allowed only for a test database under NODE_ENV=test (config.ts already limits what that can be). */
export function assertResetAllowed(config: Config): DatabaseConfig {
  const db = requireDatabase(config);
  if (config.env !== "test") throw new GuardError("db:reset:test only runs with NODE_ENV=test.");
  if (db.dialect === "mysql" && !db.database.endsWith("_test")) throw new GuardError("db:reset:test only runs on a database whose name ends with _test.");
  if (db.dialect === "sqlite" && db.path !== ":memory:" && !db.path.endsWith(".test.sqlite")) throw new GuardError("db:reset:test only runs on a .test.sqlite file.");
  return db;
}

/**
 * The environment the reset command and the integration tests use. It reads only RIO_TEST_* names, never DATABASE_URL, so a development or
 * production connection string in the shell can never be reached from a test run.
 */
export function testEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const url = env.RIO_TEST_DATABASE_URL;
  return {
    NODE_ENV: "test",
    ...(url
      ? { DB_DIALECT: "mysql", DATABASE_URL: url, DB_ALLOWED_HOST: env.RIO_TEST_DB_ALLOWED_HOST ?? "127.0.0.1", ...(env.RIO_TEST_DB_ENGINE ? { DB_ENGINE: env.RIO_TEST_DB_ENGINE } : {}) }
      : { DB_DIALECT: "sqlite", SQLITE_PATH: env.RIO_TEST_SQLITE_PATH ?? ":memory:" }),
  };
}
