import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseAdapter } from "./adapter.ts";
import { DatabaseError } from "./errors.ts";

// Versioned migrations for both dialects.
//
//   backend/migrations/mysql/0001_name.sql      one folder per dialect, the same versions and names in both
//   backend/migrations/sqlite/0001_name.sql
//
// A file holds SQL statements separated by a line containing only `--> statement-breakpoint` (no SQL parsing, so no ambiguity).
// Each applied file is recorded in a tracking table with the SHA-256 of its text (line endings normalised, so Windows and Linux agree).
// An applied file that is later edited, removed, or a new file that sorts before an applied one, stops the run.
//
// SQLite migrations that rebuild a table other tables point at (SQLite cannot alter some column rules in place) need foreign-key enforcement OFF,
// which the engine allows only outside a transaction. A file opts in with the line `-- rio:foreign-keys-off`. The runner then follows the
// procedure in the SQLite documentation: enforcement off, BEGIN, the statements, PRAGMA foreign_key_check (any row refuses the migration and
// rolls it back), COMMIT, and enforcement back ON whatever happened. Without the marker nothing changes.
//
// Dialect difference to know: SQLite runs a whole migration in one transaction and rolls it back on failure. MySQL commits DDL implicitly,
// so a migration that fails half-way keeps its earlier statements. Keep MySQL migrations to one logical change each and write them to be
// re-runnable (IF NOT EXISTS) or repair by hand; the runner records a migration only after every statement succeeded.

export const BREAKPOINT = "--> statement-breakpoint";
export const DEFAULT_TABLE = "rio_migrations";
const FILE = /^(\d{4,14})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const TABLE = /^[a-z][a-z0-9_]{0,40}$/;

export type Migration = { version: string; name: string; file: string; checksum: string; statements: string[]; foreignKeysOff: boolean };
const FOREIGN_KEYS_OFF = /^[ 	]*--[ 	]*rio:foreign-keys-off[ 	]*$/m;
export type MigrationState = "applied" | "pending" | "checksum_mismatch" | "missing_file" | "out_of_order";
export type MigrationStatus = { version: string; name: string; state: MigrationState };

export class MigrationError extends Error {
  override name = "MigrationError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const checksumOf = (text: string): string => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

export function splitStatements(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(new RegExp(`^[ \\t]*${BREAKPOINT.replace(/[>-]/g, "\\$&")}[ \\t]*$`, "m"))
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Reads and validates one dialect folder. A missing folder is an empty list; a bad file name, duplicate version or empty file is an error. */
export async function loadMigrations(dir: string): Promise<Migration[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f !== ".gitkeep" && f !== "README.md");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw new MigrationError("unreadable", "The migrations folder could not be read.");
  }
  const migrations: Migration[] = [];
  for (const file of files.sort()) {
    const match = FILE.exec(file);
    if (!match) throw new MigrationError("bad_name", `Migration file name is not allowed: ${file} (expected 0001_snake_case.sql).`);
    const text = await readFile(join(dir, file), "utf8");
    const statements = splitStatements(text);
    if (statements.length === 0) throw new MigrationError("empty", `Migration ${file} contains no statements.`);
    migrations.push({ version: match[1]!, name: match[2]!, file, checksum: checksumOf(text), statements, foreignKeysOff: FOREIGN_KEYS_OFF.test(text) });
  }
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i]!.version === migrations[i - 1]!.version) throw new MigrationError("duplicate_version", `Two migrations share version ${migrations[i]!.version}.`);
  }
  return migrations;
}

/** Static check, no database: both dialects must define the same versions and names. Returns problems (empty means fine). */
export async function checkParity(root: string): Promise<string[]> {
  const key = (m: Migration) => `${m.version}_${m.name}`;
  const reference = new Set((await loadMigrations(join(root, "mysql"))).map(key));
  const problems: string[] = [];
  // sqlite is always compared; mariadb (the local XAMPP variant) only when its folder exists. Each is compared with the MySQL 8 reference.
  for (const other of ["sqlite", "mariadb"]) {
    if (other === "mariadb" && !(await stat(join(root, other)).then((s) => s.isDirectory(), () => false))) continue;
    const names = new Set((await loadMigrations(join(root, other))).map(key));
    for (const k of reference) if (!names.has(k)) problems.push(`${k} exists for mysql but not for ${other}`);
    for (const k of names) if (!reference.has(k)) problems.push(`${k} exists for ${other} but not for mysql`);
  }
  return problems;
}

const assertTable = (table: string) => {
  if (!TABLE.test(table)) throw new MigrationError("bad_table", "The migration table name is not allowed.");
};

async function ensureTable(db: DatabaseAdapter, table: string): Promise<void> {
  assertTable(table);
  await db.query(
    db.dialect === "mysql"
      ? `CREATE TABLE IF NOT EXISTS ${table} (version VARCHAR(32) NOT NULL PRIMARY KEY, name VARCHAR(190) NOT NULL, checksum CHAR(64) NOT NULL, applied_at DATETIME(3) NOT NULL, execution_ms INT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      : `CREATE TABLE IF NOT EXISTS ${table} (version TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, execution_ms INTEGER NOT NULL) STRICT`,
  );
}

type Applied = { version: string; name: string; checksum: string };
const readApplied = async (db: DatabaseAdapter, table: string): Promise<Applied[]> =>
  (await db.query<Applied>(`SELECT version, name, checksum FROM ${table} ORDER BY version`)).rows;

export async function trackingTableExists(db: DatabaseAdapter, table = DEFAULT_TABLE): Promise<boolean> {
  assertTable(table);
  const { rows } =
    db.dialect === "mysql"
      ? await db.query("SELECT 1 AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?", [table])
      : await db.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
  return rows.length > 0;
}

/**
 * Compares the files with what the database recorded. By default the tracking table is created if it is absent (the runner needs it). With
 * `readOnly` nothing is ever written: a database that has no tracking table simply reports every migration as pending.
 */
export async function getStatus(db: DatabaseAdapter, migrations: Migration[], table = DEFAULT_TABLE, options: { readOnly?: boolean } = {}): Promise<MigrationStatus[]> {
  if (options.readOnly) {
    if (!(await trackingTableExists(db, table))) return migrations.map((m) => ({ version: m.version, name: m.name, state: "pending" as const }));
  } else {
    await ensureTable(db, table);
  }
  const applied = new Map((await readApplied(db, table)).map((a) => [a.version, a]));
  const highest = [...applied.keys()].sort().at(-1) ?? "";
  const statuses: MigrationStatus[] = migrations.map((m) => {
    const done = applied.get(m.version);
    const state: MigrationState = done
      ? done.checksum === m.checksum && done.name === m.name
        ? "applied"
        : "checksum_mismatch"
      : m.version < highest
        ? "out_of_order"
        : "pending";
    return { version: m.version, name: m.name, state };
  });
  const known = new Set(migrations.map((m) => m.version));
  for (const [version, a] of applied) if (!known.has(version)) statuses.push({ version, name: a.name, state: "missing_file" });
  return statuses.sort((x, y) => x.version.localeCompare(y.version));
}

/** The problems that make a run unsafe, as fixed sentences. Empty means every applied migration still matches its file. */
export function problemsOf(statuses: MigrationStatus[]): string[] {
  const text: Record<string, string> = {
    checksum_mismatch: "was changed after it was applied",
    missing_file: "was applied but its file is gone",
    out_of_order: "is pending but a later version is already applied",
  };
  return statuses.filter((s) => s.state in text).map((s) => `${s.version}_${s.name} ${text[s.state]}`);
}

/** Applies pending migrations in order. Idempotent: a second run applies nothing. Stops at the first problem or failure. */
export async function migrate(db: DatabaseAdapter, migrations: Migration[], table = DEFAULT_TABLE): Promise<{ applied: string[] }> {
  assertTable(table);
  return db.withLock(`migrate:${table}`, async () => {
    const statuses = await getStatus(db, migrations, table);
    const problems = problemsOf(statuses);
    if (problems.length > 0) throw new MigrationError("unsafe", `Refusing to migrate: ${problems.join("; ")}.`);
    const pending = new Set(statuses.filter((s) => s.state === "pending").map((s) => s.version));
    const applied: string[] = [];
    for (const m of migrations.filter((x) => pending.has(x.version))) {
      const started = Date.now();
      const record = (q: { query: DatabaseAdapter["query"] }) =>
        q.query(`INSERT INTO ${table} (version, name, checksum, applied_at, execution_ms) VALUES (?, ?, ?, ?, ?)`, [m.version, m.name, m.checksum, new Date(), Date.now() - started]);
      try {
        if (db.dialect === "sqlite" && m.foreignKeysOff) {
          await db.withConnection(async (c) => {
            await c.query("PRAGMA foreign_keys = OFF"); // a no-op inside a transaction, so it is set before BEGIN
            try {
              await c.query("BEGIN");
              try {
                for (const statement of m.statements) await c.query(statement);
                if ((await c.query("PRAGMA foreign_key_check")).rows.length > 0) throw new MigrationError("foreign_keys", "left rows that break a foreign key.");
                await record(c);
                await c.query("COMMIT");
              } catch (error) {
                await c.query("ROLLBACK").catch(() => undefined);
                throw error;
              }
            } finally {
              await c.query("PRAGMA foreign_keys = ON");
            }
          });
        } else if (db.dialect === "sqlite") {
          await db.transaction(async (tx) => {
            for (const statement of m.statements) await tx.query(statement);
            await record(tx);
          });
        } else {
          for (const statement of m.statements) await db.query(statement); // MySQL commits DDL implicitly, so there is nothing to wrap
          await record(db);
        }
      } catch (error) {
        if (error instanceof MigrationError && error.code === "foreign_keys") throw new MigrationError("failed", `Migration ${m.file} ${error.message} Nothing was applied; later migrations were not run.`);
        const kind = error instanceof DatabaseError ? error.kind : "unknown";
        throw new MigrationError("failed", `Migration ${m.file} failed (${kind}); later migrations were not run.`);
      }
      applied.push(m.version);
    }
    return { applied };
  });
}
