import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseAdapter, Dialect } from "./adapter.ts";
import { BREAKPOINT, checkParity, checksumOf, getStatus, loadMigrations, migrate, MigrationError, problemsOf, splitStatements } from "./migrate.ts";
import { dialects, dropTables, openTestDatabase, uniquePrefix } from "./test-db.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "rio-migrations-"));
const write = (dir: string, file: string, text: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), text);
};

describe("checksum and statement splitting", () => {
  it("does not depend on line endings (Windows checkouts versus Linux CI)", () => {
    expect(checksumOf("CREATE TABLE a (x INT);\nSELECT 1;\n")).toBe(checksumOf("CREATE TABLE a (x INT);\r\nSELECT 1;\r\n"));
  });
  it("changes when the text changes", () => {
    expect(checksumOf("SELECT 1;")).not.toBe(checksumOf("SELECT 2;"));
    expect(checksumOf("SELECT 1;")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("splits on the breakpoint line only, in any line-ending style", () => {
    expect(splitStatements(`A;\n${BREAKPOINT}\nB;\r\n${BREAKPOINT}  \r\n\r\nC;`)).toEqual(["A;", "B;", "C;"]);
    expect(splitStatements("A; B; -- statement-breakpoint inside a comment")).toEqual(["A; B; -- statement-breakpoint inside a comment"]);
    expect(splitStatements(`\n${BREAKPOINT}\n`)).toEqual([]);
  });
});

describe("loadMigrations", () => {
  it("returns files in version order with their checksums", async () => {
    const dir = tempDir();
    write(dir, "0002_second.sql", "SELECT 2;");
    write(dir, "0001_first.sql", `SELECT 1;\n${BREAKPOINT}\nSELECT 1.5;`);
    const list = await loadMigrations(dir);
    expect(list.map((m) => [m.version, m.name, m.statements.length])).toEqual([["0001", "first", 2], ["0002", "second", 1]]);
    rmSync(dir, { recursive: true });
  });
  it("treats a missing folder as no migrations", async () => {
    expect(await loadMigrations(join(tmpdir(), "rio-does-not-exist-xyz"))).toEqual([]);
  });
  it.each(["1_short.sql", "0001_Upper.sql", "0001-dash.sql", "0001_.sql", "0001_a.txt", "notes.sql"])("rejects the file name %s", async (name) => {
    const dir = tempDir();
    write(dir, name, "SELECT 1;");
    await expect(loadMigrations(dir)).rejects.toMatchObject({ code: expect.stringMatching(/bad_name/) });
    rmSync(dir, { recursive: true });
  });
  it("rejects an empty file and a duplicate version", async () => {
    const empty = tempDir();
    write(empty, "0001_empty.sql", `-- nothing\n`.replace("-- nothing", ""));
    await expect(loadMigrations(empty)).rejects.toMatchObject({ code: "empty" });
    const dup = tempDir();
    write(dup, "0001_a.sql", "SELECT 1;");
    write(dup, "0001_b.sql", "SELECT 1;");
    await expect(loadMigrations(dup)).rejects.toMatchObject({ code: "duplicate_version" });
    [empty, dup].forEach((d) => rmSync(d, { recursive: true }));
  });
});

describe("dialect parity", () => {
  it("passes when both folders have the same versions and names, and lists every difference otherwise", async () => {
    const root = tempDir();
    write(join(root, "mysql"), "0001_a.sql", "SELECT 1;");
    write(join(root, "sqlite"), "0001_a.sql", "SELECT 1;");
    expect(await checkParity(root)).toEqual([]);
    write(join(root, "mysql"), "0002_only_mysql.sql", "SELECT 1;");
    write(join(root, "sqlite"), "0003_only_sqlite.sql", "SELECT 1;");
    expect(await checkParity(root)).toEqual(["0002_only_mysql exists for mysql but not for sqlite", "0003_only_sqlite exists for sqlite but not for mysql"]);
    rmSync(root, { recursive: true });
  });
  it("holds for the real migrations folder (M2A has none, so both are empty)", async () => {
    expect(await checkParity(join(import.meta.dirname, "../../migrations"))).toEqual([]);
  });
});

describe.each(dialects)("%s migration runner", (dialect: Dialect) => {
  const p = uniquePrefix();
  const track = `${p}_migrations`;
  const tables = [`${p}_a`, `${p}_b`, `${p}_c`];
  let db: DatabaseAdapter;
  let dir: string;

  const create = (name: string, suffix = "") => `CREATE TABLE ${name} (id ${dialect === "mysql" ? "INT" : "INTEGER"} PRIMARY KEY, v ${dialect === "mysql" ? "VARCHAR(20)" : "TEXT"} NULL)${suffix};`;
  const files = (extra: Record<string, string> = {}) => {
    for (const f of ["0001_create_a.sql", "0002_create_b.sql", "0003_create_c.sql"]) rmSync(join(dir, f), { force: true });
    write(dir, "0001_create_a.sql", create(tables[0]!));
    write(dir, "0002_create_b.sql", create(tables[1]!));
    write(dir, "0003_create_c.sql", create(tables[2]!));
    for (const [name, text] of Object.entries(extra)) write(dir, name, text);
  };
  const exists = async (name: string) => {
    try {
      await db.query(`SELECT 1 FROM ${name} LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  };
  const reset = async () => dropTables(db, [...tables, track, `${p}_x1`, `${p}_x2`]);

  beforeAll(() => {
    db = openTestDatabase(dialect);
    dir = tempDir();
  });
  afterAll(async () => {
    await reset();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies pending files in order, records name and checksum, and is idempotent", async () => {
    await reset();
    files();
    const migrations = await loadMigrations(dir);
    expect((await getStatus(db, migrations, track)).map((s) => s.state)).toEqual(["pending", "pending", "pending"]);
    expect((await migrate(db, migrations, track)).applied).toEqual(["0001", "0002", "0003"]);
    expect(await Promise.all(tables.map(exists))).toEqual([true, true, true]);
    const rows = (await db.query<{ version: string; name: string; checksum: string }>(`SELECT version, name, checksum FROM ${track} ORDER BY version`)).rows;
    expect(rows.map((r) => [r.version, r.name])).toEqual([["0001", "create_a"], ["0002", "create_b"], ["0003", "create_c"]]);
    expect(rows[0]?.checksum).toBe(migrations[0]?.checksum);
    // second run: nothing to do, nothing re-executed (re-running CREATE TABLE would fail)
    expect((await migrate(db, migrations, track)).applied).toEqual([]);
    expect((await getStatus(db, migrations, track)).every((s) => s.state === "applied")).toBe(true);
  });

  it("applies only the new file when one is added later", async () => {
    write(dir, "0004_create_x1.sql", create(`${p}_x1`));
    expect((await migrate(db, await loadMigrations(dir), track)).applied).toEqual(["0004"]);
    expect(await exists(`${p}_x1`)).toBe(true);
  });

  it("refuses to run when an applied file was edited (checksum mismatch) and changes nothing", async () => {
    write(dir, "0001_create_a.sql", `${create(tables[0]!)}\n-- edited after it was applied`);
    write(dir, "0005_create_x2.sql", create(`${p}_x2`));
    const migrations = await loadMigrations(dir);
    const statuses = await getStatus(db, migrations, track);
    expect(statuses.find((s) => s.version === "0001")?.state).toBe("checksum_mismatch");
    expect(problemsOf(statuses)).toEqual(["0001_create_a was changed after it was applied"]);
    await expect(migrate(db, migrations, track)).rejects.toMatchObject({ code: "unsafe" });
    expect(await exists(`${p}_x2`)).toBe(false); // the later, valid file was not applied either
  });

  it("refuses when an applied migration's file has disappeared", async () => {
    files();
    rmSync(join(dir, "0002_create_b.sql"));
    rmSync(join(dir, "0004_create_x1.sql"), { force: true });
    rmSync(join(dir, "0005_create_x2.sql"), { force: true });
    const statuses = await getStatus(db, await loadMigrations(dir), track);
    expect(statuses.find((s) => s.version === "0002")?.state).toBe("missing_file");
    await expect(migrate(db, await loadMigrations(dir), track)).rejects.toMatchObject({ code: "unsafe" });
  });

  it("refuses a new file that sorts before an applied one (out of order)", async () => {
    files();
    rmSync(join(dir, "0004_create_x1.sql"), { force: true });
    write(dir, "0002a_never.sql", "x"); // wrong name pattern is rejected by the loader, so use a proper low version instead
    rmSync(join(dir, "0002a_never.sql"));
    await reset();
    await migrate(db, await loadMigrations(dir), track); // apply 1..3
    write(dir, "00025_between.sql", create(`${p}_x2`)); // version 00025 < 0003, already applied
    const statuses = await getStatus(db, await loadMigrations(dir), track);
    expect(statuses.find((s) => s.version === "00025")?.state).toBe("out_of_order");
    await expect(migrate(db, await loadMigrations(dir), track)).rejects.toMatchObject({ code: "unsafe" });
    rmSync(join(dir, "00025_between.sql"));
  });

  it("stops at a failing migration, applies nothing after it, and reports no SQL or driver text", async () => {
    await reset();
    files();
    write(dir, "0002_create_b.sql", `${create(tables[1]!)}\n${BREAKPOINT}\nTHIS IS NOT SQL secret_token_123;`);
    const error = (await migrate(db, await loadMigrations(dir), track).then(() => undefined, (e: unknown) => e)) as MigrationError;
    expect(error).toBeInstanceOf(MigrationError);
    expect(error.message).toBe("Migration 0002_create_b.sql failed (query_failed); later migrations were not run.");
    expect(error.message).not.toMatch(/secret_token_123|NOT SQL/);
    expect(await exists(tables[0]!)).toBe(true); // 0001 stays applied
    expect(await exists(tables[2]!)).toBe(false); // 0003 never ran
    const recorded = (await db.query<{ version: string }>(`SELECT version FROM ${track}`)).rows.map((r) => r.version);
    expect(recorded).toEqual(["0001"]); // a failed migration is not recorded
    // The dialect difference, pinned: SQLite undoes the half-applied file, MySQL keeps the statement that already ran (implicit DDL commit).
    expect(await exists(tables[1]!)).toBe(dialect === "mysql");
  });

  it("two runners started at once apply each migration exactly once", async () => {
    await reset();
    files();
    const migrations = await loadMigrations(dir);
    const results = await Promise.all([migrate(db, migrations, track), migrate(db, migrations, track)]);
    expect(results.flatMap((r) => r.applied).sort()).toEqual(["0001", "0002", "0003"]);
  });

  it("rejects an unsafe tracking-table name before touching the database", async () => {
    await expect(migrate(db, [], "x; DROP TABLE y")).rejects.toMatchObject({ code: "bad_table" });
  });
});
