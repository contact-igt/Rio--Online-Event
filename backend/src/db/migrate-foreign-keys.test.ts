import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadMigrations, migrate, MigrationError } from "./migrate.ts";
import { openSqlite } from "./sqlite.ts";

// The SQLite-only "-- rio:foreign-keys-off" marker: a migration that rebuilds a table other tables point at runs with enforcement off, is
// checked with PRAGMA foreign_key_check before it commits, is rolled back if anything is left broken, and enforcement is always switched on again.

const folder = mkdtempSync(join(tmpdir(), "rio-fk-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
let n = 0;
const BREAK = "\n--> statement-breakpoint\n";
const fresh = async () => {
  const dir = join(folder, `case${++n}`);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir);
  const db = openSqlite({ dialect: "sqlite", path: ":memory:" });
  return { dir, db, put: (name: string, text: string) => writeFileSync(join(dir, name), text) };
};
const SETUP = ["CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT", "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent (id)) STRICT", "INSERT INTO parent VALUES (1, 'a'), (2, 'b')", "INSERT INTO child VALUES (1, 1), (2, 2)"].join(BREAK);
const REBUILD = ["PRAGMA legacy_alter_table = ON", "CREATE TABLE parent_new (id INTEGER PRIMARY KEY, name TEXT) STRICT", "INSERT INTO parent_new SELECT id, name FROM parent", "DROP TABLE parent", "ALTER TABLE parent_new RENAME TO parent", "PRAGMA legacy_alter_table = OFF"].join(BREAK);
const pragma = async (db: ReturnType<typeof openSqlite>, name: string) => Object.values((await db.query(`PRAGMA ${name}`)).rows[0]!)[0];

describe("migrations that opt out of foreign-key enforcement (SQLite)", () => {
  it("reads the marker from the file and nothing else", async () => {
    const { dir, db, put } = await fresh();
    put("0001_plain.sql", "CREATE TABLE a (id INTEGER) STRICT");
    put("0002_marked.sql", `-- rio:foreign-keys-off\n-- other comment\nCREATE TABLE b (id INTEGER) STRICT`);
    put("0003_mentioned.sql", `-- this file does not use rio:foreign-keys-off\nCREATE TABLE c (id INTEGER) STRICT`);
    const loaded = await loadMigrations(dir);
    expect(loaded.map((m) => [m.version, m.foreignKeysOff])).toEqual([["0001", false], ["0002", true], ["0003", false]]);
    await db.close();
  });

  it("rebuilds a parent table that has child rows, keeping every row and key, and enforcement is back on afterwards", async () => {
    const { dir, db, put } = await fresh();
    put("0001_setup.sql", SETUP);
    put("0002_rebuild.sql", `-- rio:foreign-keys-off\n${REBUILD}`);
    expect(await migrate(db, await loadMigrations(dir))).toEqual({ applied: ["0001", "0002"] });
    expect((await db.query("SELECT id, name FROM parent ORDER BY id")).rows).toEqual([{ id: 1, name: "a" }, { id: 2, name: "b" }]);
    expect(await pragma(db, "foreign_keys")).toBe(1);
    expect(await pragma(db, "legacy_alter_table")).toBe(0);
    await expect(db.query("INSERT INTO child VALUES (3, 99)")).rejects.toMatchObject({ constraint: "foreign_key" }); // the child still points at the rebuilt parent
    await expect(db.query("DELETE FROM parent WHERE id = 1")).rejects.toMatchObject({ constraint: "foreign_key" });
    await db.close();
  });

  it("fails the same rebuild without the marker: that is why the marker exists", async () => {
    const { dir, db, put } = await fresh();
    put("0001_setup.sql", SETUP);
    put("0002_rebuild.sql", REBUILD);
    await expect(migrate(db, await loadMigrations(dir))).rejects.toBeInstanceOf(MigrationError);
    expect((await db.query("SELECT COUNT(*) AS n FROM parent")).rows[0]).toEqual({ n: 2 }); // and it rolled back cleanly
    await db.close();
  });

  it("refuses a marked migration that leaves a broken foreign key, rolls everything back, and switches enforcement on again", async () => {
    const { dir, db, put } = await fresh();
    put("0001_setup.sql", SETUP);
    put("0002_orphan.sql", `-- rio:foreign-keys-off\nDELETE FROM parent WHERE id = 1${BREAK}CREATE TABLE marker (id INTEGER) STRICT`);
    const error = await migrate(db, await loadMigrations(dir)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as Error).message).toMatch(/foreign key/i);
    expect((error as Error).message).toContain("Nothing was applied");
    expect((await db.query("SELECT COUNT(*) AS n FROM parent")).rows[0]).toEqual({ n: 2 });
    expect((await db.query("SELECT name FROM sqlite_master WHERE name = 'marker'")).rows).toEqual([]);
    expect((await db.query("SELECT version FROM rio_migrations ORDER BY version")).rows).toEqual([{ version: "0001" }]); // 0002 was not recorded
    expect(await pragma(db, "foreign_keys")).toBe(1);
    await db.close();
  });

  it("switches enforcement back on even when a statement fails, and records nothing", async () => {
    const { dir, db, put } = await fresh();
    put("0001_setup.sql", SETUP);
    put("0002_broken.sql", `-- rio:foreign-keys-off\nSELECT * FROM no_such_table`);
    await expect(migrate(db, await loadMigrations(dir))).rejects.toBeInstanceOf(MigrationError);
    expect(await pragma(db, "foreign_keys")).toBe(1);
    expect((await db.query("SELECT COUNT(*) AS n FROM rio_migrations")).rows[0]).toEqual({ n: 1 });
    await db.close();
  });

  it("changes the checksum when the marker is added or removed, so an applied file cannot quietly gain it", async () => {
    const { dir, db, put } = await fresh();
    put("0001_x.sql", "CREATE TABLE x (id INTEGER) STRICT");
    const plain = (await loadMigrations(dir))[0]!.checksum;
    put("0001_x.sql", "-- rio:foreign-keys-off\nCREATE TABLE x (id INTEGER) STRICT");
    expect((await loadMigrations(dir))[0]!.checksum).not.toBe(plain);
    await db.close();
  });
});
