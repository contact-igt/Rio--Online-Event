import type { DatabaseAdapter } from "./adapter.ts";
import { DatabaseError } from "./errors.ts";
import { DEFAULT_TABLE, getStatus, problemsOf, type Migration } from "./migrate.ts";

// "Is the database ready to serve requests?" as a pure function over the adapter. M2B only provides it; M3 decides which route (if any)
// exposes it, because health.ts must stay a liveness check that never touches the database. It changes nothing: it creates no table and
// applies no migration, and it answers with a fixed reason, never driver text.

export type Readiness =
  | { ready: true }
  | { ready: false; reason: "unavailable" | "migrations_missing" | "migrations_pending" | "migrations_unsafe" };

export async function checkReadiness(db: DatabaseAdapter, migrations: Migration[], table = DEFAULT_TABLE): Promise<Readiness> {
  try {
    await db.ping();
    const exists =
      db.dialect === "mysql"
        ? await db.query("SELECT 1 AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?", [table])
        : await db.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
    if (exists.rows.length === 0) return { ready: false, reason: "migrations_missing" };
    const statuses = await getStatus(db, migrations, table); // the table exists, so this reads only
    if (problemsOf(statuses).length > 0) return { ready: false, reason: "migrations_unsafe" };
    return statuses.some((s) => s.state === "pending") ? { ready: false, reason: "migrations_pending" } : { ready: true };
  } catch (error) {
    if (error instanceof DatabaseError) return { ready: false, reason: "unavailable" };
    throw error;
  }
}
