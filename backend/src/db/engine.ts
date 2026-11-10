import type { DatabaseConfig } from "../config.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { GuardError } from "./guards.ts";

// MySQL 8 (production) and MariaDB (the server XAMPP ships, for local development) speak the same protocol, so both use the "mysql" dialect
// and the same driver. They differ in SQL details (collation names, a few functions), so each has its own migration folder, chosen by
// DB_ENGINE, and the command-line tools refuse to run when the setting and the server disagree. Applying MySQL 8 migrations to MariaDB
// (or the other way round) would fail half-way and leave a partly built schema.

/** The folder under backend/migrations that holds this database's migrations. */
export const migrationFolder = (database: DatabaseConfig): string => (database.dialect === "sqlite" ? "sqlite" : database.engine);

/** `SELECT VERSION()` says "10.4.32-MariaDB" on MariaDB and "8.0.x" on MySQL. */
export const engineOfVersion = (version: string): "mysql" | "mariadb" => (/mariadb/i.test(version) ? "mariadb" : "mysql");

/** Fixed sentences only: the server's version text and the connection settings are never part of the message. */
export async function assertEngineMatches(db: DatabaseAdapter, database: DatabaseConfig): Promise<void> {
  if (database.dialect !== "mysql") return;
  const row = (await db.query<{ v: string }>("SELECT VERSION() AS v")).rows[0];
  const actual = engineOfVersion(String(row?.v ?? ""));
  if (actual === database.engine) return;
  throw new GuardError(
    actual === "mariadb"
      ? "The database server is MariaDB but DB_ENGINE is mysql. Set DB_ENGINE=mariadb (local XAMPP development only); the MySQL 8 migrations will not run on it."
      : "The database server is MySQL but DB_ENGINE is mariadb. Set DB_ENGINE=mysql.",
  );
}
