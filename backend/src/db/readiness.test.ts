import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseAdapter, Dialect } from "./adapter.ts";
import { DatabaseError } from "./errors.ts";
import { checksumOf, migrate, type Migration } from "./migrate.ts";
import { checkReadiness } from "./readiness.ts";
import { openSqlite } from "./sqlite.ts";
import { dialects, dropTables, openTestDatabase, uniquePrefix } from "./test-db.ts";

// The M2A leftovers: the MySQL session settings really are applied to every pooled connection, SQLite really runs in WAL mode with
// foreign keys on, and readiness reports the database's state without changing anything.

const caught = async (work: Promise<unknown>): Promise<unknown> => work.then(() => undefined, (error: unknown) => error);

describe.runIf(dialects.includes("mysql"))("mysql session settings", () => {
  const table = `${uniquePrefix()}_strict`;
  let db: DatabaseAdapter;
  beforeAll(() => {
    db = openTestDatabase("mysql");
  });
  afterAll(async () => {
    await dropTables(db, [table]);
    await db.close();
  });

  it("applies strict mode, no zero dates and UTC to every pooled connection", async () => {
    // Several connections held at once, so the pool has to open more than one.
    const seen = await Promise.all(
      Array.from({ length: 6 }, () =>
        db.withConnection(async (c) => {
          const { rows } = await c.query<{ mode: string; zone: string }>("SELECT @@SESSION.sql_mode AS mode, @@SESSION.time_zone AS zone");
          await c.query("SELECT SLEEP(0.1)");
          return rows[0]!;
        }),
      ),
    );
    for (const { mode, zone } of seen) {
      expect(zone).toBe("+00:00");
      for (const flag of ["STRICT_ALL_TABLES", "NO_ZERO_DATE", "NO_ZERO_IN_DATE", "ONLY_FULL_GROUP_BY", "ERROR_FOR_DIVISION_BY_ZERO", "NO_ENGINE_SUBSTITUTION"]) {
        expect(mode.split(","), flag).toContain(flag);
      }
    }
  });

  it("refuses silent truncation, zero dates and division by zero in a write instead of storing something else", async () => {
    await db.query(`CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(5) NOT NULL, at DATETIME(3) NULL, qty INT NOT NULL) ENGINE=InnoDB`);
    const rejected = async (sql: string) => expect(await caught(db.query(sql))).toBeInstanceOf(DatabaseError);
    await rejected(`INSERT INTO ${table} (id, name, qty) VALUES (1, 'too long for five', 1)`);
    await rejected(`INSERT INTO ${table} (id, name, at, qty) VALUES (2, 'ok', '0000-00-00 00:00:00', 1)`);
    await rejected(`INSERT INTO ${table} (id, name, qty) VALUES (3, 'ok', 1 / 0)`);
    await rejected(`INSERT INTO ${table} (id, qty) VALUES (4, 1)`); // a column without a default must be given
    expect((await db.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]).toEqual({ n: 0 });
  });
});

describe("sqlite file database", () => {
  const folder = mkdtempSync(join(tmpdir(), "rio-wal-"));
  const path = join(folder, "wal.test.sqlite");
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  it("uses write-ahead logging, enforces foreign keys and waits for a busy file", async () => {
    const db = openSqlite({ dialect: "sqlite", path });
    try {
      expect((await db.query<{ journal_mode: string }>("PRAGMA journal_mode")).rows[0]).toEqual({ journal_mode: "wal" });
      expect((await db.query<{ foreign_keys: number }>("PRAGMA foreign_keys")).rows[0]).toEqual({ foreign_keys: 1 });
      expect((await db.query<{ timeout: number }>("PRAGMA busy_timeout")).rows[0]).toEqual({ timeout: 5000 });
      await db.query("CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT");
      await db.query("CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent (id)) STRICT");
      expect(await caught(db.query("INSERT INTO child (parent_id) VALUES (1)"))).toMatchObject({ kind: "constraint", constraint: "foreign_key" });
    } finally {
      await db.close();
    }
  });

  it("lets a reader see committed data while another connection is writing (the point of WAL)", async () => {
    const writer = openSqlite({ dialect: "sqlite", path });
    const reader = openSqlite({ dialect: "sqlite", path });
    try {
      await writer.query("INSERT INTO parent (id) VALUES (1)");
      let readDuringWrite = -1;
      await writer.transaction(async (tx) => {
        await tx.query("INSERT INTO parent (id) VALUES (2)");
        readDuringWrite = Number((await reader.query<{ n: number }>("SELECT COUNT(*) AS n FROM parent")).rows[0]!.n);
      });
      expect(readDuringWrite).toBe(1); // the reader saw the committed row and not the uncommitted one, without waiting
      expect(Number((await reader.query<{ n: number }>("SELECT COUNT(*) AS n FROM parent")).rows[0]!.n)).toBe(2);
    } finally {
      await writer.close();
      await reader.close();
    }
  });

  it("keeps an in-memory database in memory mode, still with foreign keys on", async () => {
    const db = openSqlite({ dialect: "sqlite", path: ":memory:" });
    try {
      expect((await db.query<{ journal_mode: string }>("PRAGMA journal_mode")).rows[0]).toEqual({ journal_mode: "memory" });
      expect((await db.query<{ foreign_keys: number }>("PRAGMA foreign_keys")).rows[0]).toEqual({ foreign_keys: 1 });
    } finally {
      await db.close();
    }
  });
});

describe.each(dialects)("%s readiness", (dialect: Dialect) => {
  const p = uniquePrefix();
  const tracking = `${p}_migrations`;
  const tableOf = (name: string) => `${p}_${name}`;
  let db: DatabaseAdapter;

  const migration = (version: string, name: string, statement: string): Migration => ({ version, name, file: `${version}_${name}.sql`, checksum: checksumOf(statement), statements: [statement], foreignKeysOff: false });
  const first = () => migration("0001", "first_table", `CREATE TABLE ${tableOf("a")} (id INTEGER PRIMARY KEY)`);
  const second = () => migration("0002", "second_table", `CREATE TABLE ${tableOf("b")} (id INTEGER PRIMARY KEY)`);
  const trackingExists = async () =>
    (
      await db.query(
        dialect === "mysql" ? "SELECT 1 AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?" : "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tracking],
      )
    ).rows.length === 1;

  beforeAll(() => {
    db = openTestDatabase(dialect);
  });
  afterAll(async () => {
    await dropTables(db, [tableOf("a"), tableOf("b"), tracking]);
    await db.close();
  });

  it("says the migrations are missing on a database nobody has migrated, and changes nothing", async () => {
    expect(await checkReadiness(db, [first()], tracking)).toEqual({ ready: false, reason: "migrations_missing" });
    expect(await trackingExists()).toBe(false); // looking did not create the tracking table
  });

  it("says ready once every migration is applied", async () => {
    await migrate(db, [first()], tracking);
    expect(await checkReadiness(db, [first()], tracking)).toEqual({ ready: true });
  });

  it("says pending when a newer migration has not been applied, and ready again after it is", async () => {
    expect(await checkReadiness(db, [first(), second()], tracking)).toEqual({ ready: false, reason: "migrations_pending" });
    await migrate(db, [first(), second()], tracking);
    expect(await checkReadiness(db, [first(), second()], tracking)).toEqual({ ready: true });
  });

  it("says unsafe when an applied migration was edited or its file is gone", async () => {
    const edited = migration("0001", "first_table", `CREATE TABLE ${tableOf("a")} (id INTEGER PRIMARY KEY, extra INTEGER)`);
    expect(await checkReadiness(db, [edited, second()], tracking)).toEqual({ ready: false, reason: "migrations_unsafe" });
    expect(await checkReadiness(db, [first()], tracking)).toEqual({ ready: false, reason: "migrations_unsafe" });
  });

  it("says unavailable when the database cannot be reached, without leaking why", async () => {
    const closed = openTestDatabase(dialect);
    await closed.ping(); // as in adapter.test.ts: an adapter closed before its first use would simply connect afresh
    await closed.close();
    const result = await checkReadiness(closed, [first()], tracking);
    expect(result).toEqual({ ready: false, reason: "unavailable" });
    expect(JSON.stringify(result)).not.toMatch(/host|password|mysql:|select/i);
  });
});
