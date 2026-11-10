import { fileURLToPath } from "node:url";
import type { DatabaseAdapter, Dialect } from "./adapter.ts";
import { loadMigrations, migrate } from "./migrate.ts";
import { dropTables } from "./test-db.ts";

// Test support only (excluded from the build). Installs the real application migrations into a TEST database and removes them again.
// The application tables have fixed names, so two test files must never use the same database at the same time: vitest.config.ts runs test
// files one after another for that reason.

export const APP_TABLES = [
  "rate_limits", "email_outbox", "winners", "scores", "judge_assignments", "judge_profiles", "video_uploads", "duplicate_reviews", "entry_answers",
  "registration_recovery", "submissions", "questions", "question_sets", "event_settings", "events", "audit_log", "staff_sessions", "staff_users",
];

/** Which migration folder a test database uses: the MariaDB variants when RIO_TEST_DB_ENGINE=mariadb, otherwise the dialect's own. */
export const migrationsDir = (dialect: Dialect): string =>
  fileURLToPath(new URL(`../../migrations/${dialect === "mysql" && process.env.RIO_TEST_DB_ENGINE === "mariadb" ? "mariadb" : dialect}`, import.meta.url));

export async function dropAppSchema(db: DatabaseAdapter, tracking: string): Promise<void> {
  await db.query("DROP VIEW IF EXISTS published_winners");
  await dropTables(db, [...APP_TABLES, tracking]);
}

/** A fresh copy of the whole application schema, tracked in its own table so it never touches the real `rio_migrations`. */
export async function installAppSchema(db: DatabaseAdapter, tracking: string): Promise<void> {
  await dropAppSchema(db, tracking);
  await migrate(db, await loadMigrations(migrationsDir(db.dialect)), tracking);
}
