import { inspect } from "node:util";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseAdapter, Dialect } from "./adapter.ts";
import { DatabaseError } from "./errors.ts";
import { dialects, dropTables, mysqlRequired, openTestDatabase, uniquePrefix } from "./test-db.ts";
import { asDate } from "./values.ts";

// One suite, run against every configured dialect. A behaviour that differs between SQLite and MySQL is not hidden: it is asserted per
// dialect in "boundaries", so a change in either engine or driver shows up here.

it("MySQL integration tests are mandatory in CI", () => {
  if (mysqlRequired) expect(dialects, "RIO_TEST_DATABASE_URL must point at the disposable MySQL test database").toContain("mysql");
});

const caught = async (work: Promise<unknown>): Promise<unknown> => work.then(() => undefined, (error: unknown) => error);

describe.each(dialects)("%s adapter", (dialect: Dialect) => {
  const p = uniquePrefix();
  const items = `${p}_items`;
  const children = `${p}_children`;
  const stamps = `${p}_stamps`;
  let db: DatabaseAdapter;

  beforeAll(async () => {
    db = openTestDatabase(dialect);
    const mysql = dialect === "mysql";
    await db.query(
      mysql
        ? `CREATE TABLE ${items} (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(60) NOT NULL, qty INT NOT NULL, note VARCHAR(100) NULL, UNIQUE KEY ${p}_uq (name), CONSTRAINT ${p}_qty CHECK (qty >= 0)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        : `CREATE TABLE ${items} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, qty INTEGER NOT NULL CHECK (qty >= 0), note TEXT)`,
    );
    await db.query(
      mysql
        ? `CREATE TABLE ${children} (id INT AUTO_INCREMENT PRIMARY KEY, item_id INT NOT NULL, CONSTRAINT ${p}_fk FOREIGN KEY (item_id) REFERENCES ${items} (id)) ENGINE=InnoDB`
        : `CREATE TABLE ${children} (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES ${items} (id))`,
    );
    await db.query(mysql ? `CREATE TABLE ${stamps} (id INT PRIMARY KEY, at DATETIME(3) NOT NULL, big BIGINT NULL) ENGINE=InnoDB` : `CREATE TABLE ${stamps} (id INTEGER PRIMARY KEY, at TEXT NOT NULL, big INTEGER)`);
  });
  afterAll(async () => {
    await dropTables(db, [children, stamps, items]);
    await db.close();
  });

  const insert = (name: string, qty = 1) => db.query(`INSERT INTO ${items} (name, qty) VALUES (?, ?)`, [name, qty]);
  const count = async (name: string) => Number((await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${items} WHERE name = ?`, [name])).rows[0]?.n);

  describe("connection", () => {
    it("reports its dialect and answers a ping", async () => {
      expect(db.dialect).toBe(dialect);
      await expect(db.ping()).resolves.toBeUndefined();
    });

    it("binds parameters and round-trips Tamil and four-byte text", async () => {
      const text = "தமிழ் மொழி 𝒜";
      await insert(text, 3);
      const { rows } = await db.query<{ name: string; qty: number }>(`SELECT name, qty FROM ${items} WHERE name = ?`, [text]);
      expect(rows).toEqual([{ name: text, qty: 3 }]);
    });

    it("treats a quote in a value as data, not SQL", async () => {
      const hostile = "x'); DROP TABLE nothing; --";
      await insert(hostile);
      expect(await count(hostile)).toBe(1);
    });

    it("closes more than once without error, and refuses queries afterwards with a sanitised error", async () => {
      const other = openTestDatabase(dialect);
      await other.ping();
      await other.close();
      await expect(other.close()).resolves.toBeUndefined();
      expect(await caught(other.query("SELECT 1"))).toBeInstanceOf(DatabaseError);
    });
  });

  describe("affected rows", () => {
    it("counts matched rows for UPDATE (even when nothing changes) and DELETE, and 0 for SELECT", async () => {
      await insert("count-me", 5);
      expect((await db.query(`UPDATE ${items} SET qty = 5 WHERE name = ?`, ["count-me"])).affectedRows).toBe(1); // same value: still "matched"
      expect((await db.query(`SELECT * FROM ${items} WHERE name = ?`, ["count-me"])).affectedRows).toBe(0);
      expect((await db.query(`DELETE FROM ${items} WHERE name = ?`, ["count-me"])).affectedRows).toBe(1);
      expect((await db.query(`DELETE FROM ${items} WHERE name = ?`, ["count-me"])).affectedRows).toBe(0);
    });
  });

  describe("transactions", () => {
    it("commits when the work resolves", async () => {
      const result = await db.transaction(async (tx) => {
        await tx.query(`INSERT INTO ${items} (name, qty) VALUES (?, ?)`, ["tx-commit", 1]);
        return "done";
      });
      expect(result).toBe("done");
      expect(await count("tx-commit")).toBe(1);
    });

    it("rolls back everything when the work throws, and rethrows the caller's own error unchanged", async () => {
      const mine = new RangeError("caller problem");
      const error = await caught(
        db.transaction(async (tx) => {
          await tx.query(`INSERT INTO ${items} (name, qty) VALUES (?, ?)`, ["tx-rollback", 1]);
          throw mine;
        }),
      );
      expect(error).toBe(mine);
      expect(await count("tx-rollback")).toBe(0);
    });

    it("rolls back earlier statements when a later one fails, and reports a sanitised error", async () => {
      await insert("tx-dup");
      const error = await caught(
        db.transaction(async (tx) => {
          await tx.query(`INSERT INTO ${items} (name, qty) VALUES (?, ?)`, ["tx-first", 1]);
          await tx.query(`INSERT INTO ${items} (name, qty) VALUES (?, ?)`, ["tx-dup", 1]);
        }),
      );
      expect(error).toBeInstanceOf(DatabaseError);
      expect(error).toMatchObject({ kind: "constraint", constraint: "unique" });
      expect(await count("tx-first")).toBe(0);
    });

    it("keeps concurrent transactions apart and commits both", async () => {
      await Promise.all(["tx-a", "tx-b"].map((name) => db.transaction(async (tx) => void (await tx.query(`INSERT INTO ${items} (name, qty) VALUES (?, ?)`, [name, 1])))));
      expect([await count("tx-a"), await count("tx-b")]).toEqual([1, 1]);
    });

    it("exposes a type-safe builder bound to the same transaction", async () => {
      await db
        .transaction(async (tx) => {
          await sql`INSERT INTO ${sql.raw(items)} (name, qty) VALUES (${"tx-kysely"}, ${1})`.execute(tx.kysely);
          throw new Error("undo");
        })
        .catch(() => undefined);
      expect(await count("tx-kysely")).toBe(0);
      await db.transaction(async (tx) => void (await sql`INSERT INTO ${sql.raw(items)} (name, qty) VALUES (${"tx-kysely"}, ${1})`.execute(tx.kysely)));
      expect(await count("tx-kysely")).toBe(1);
    });
  });

  describe("error sanitisation", () => {
    it.each([
      ["unique", () => insert("dup-key")],
      ["check", () => insert("neg-qty", -1)],
      ["foreign_key", () => db.query(`INSERT INTO ${children} (item_id) VALUES (?)`, [987654])],
      ["not_null", () => db.query(`INSERT INTO ${items} (name, qty) VALUES (?, ?)`, [null, 1])],
    ] as const)("maps a %s violation to a constraint error", async (constraint, act) => {
      if (constraint === "unique") await insert("dup-key");
      const error = await caught(act());
      expect(error).toBeInstanceOf(DatabaseError);
      expect(error).toMatchObject({ kind: "constraint", constraint, retryable: false });
    });

    it("never carries SQL, table names, values or driver text", async () => {
      const secret = "S3CRET-Value-9f2";
      await insert(secret);
      const error = (await caught(insert(secret))) as DatabaseError;
      for (const text of [error.message, JSON.stringify(error), inspect(error, { depth: 5 }), String(error.stack)]) {
        expect(text).not.toContain(secret);
        expect(text).not.toContain(items);
        expect(text).not.toMatch(/INSERT|VALUES|Duplicate|UNIQUE constraint/i);
      }
      expect(error.cause).toBeUndefined();
    });

    it("turns a syntax error into query_failed without echoing the statement", async () => {
      const error = (await caught(db.query("SELEKT secret_column FROM nowhere"))) as DatabaseError;
      expect(error).toBeInstanceOf(DatabaseError);
      expect(error.kind).toBe("query_failed");
      expect(inspect(error)).not.toMatch(/SELEKT|secret_column|nowhere/);
    });
  });

  describe("connection and lock helpers", () => {
    it("withConnection keeps one connection for all its statements", async () => {
      const seen = await db.withConnection(async (c) => {
        await c.query(`CREATE TEMPORARY TABLE ${p}_tmp (a INT)`);
        await c.query(`INSERT INTO ${p}_tmp (a) VALUES (?)`, [41]);
        return (await c.query<{ a: number }>(`SELECT a + 1 AS a FROM ${p}_tmp`)).rows[0]?.a;
      });
      expect(seen).toBe(42);
    });

    it("withLock runs same-named work one at a time", async () => {
      let running = 0;
      let peak = 0;
      const job = () =>
        db.withLock("probe", async () => {
          peak = Math.max(peak, ++running);
          await new Promise((r) => setTimeout(r, 40));
          running--;
        });
      await Promise.all([job(), job(), job()]);
      expect(peak).toBe(1);
    });

    it("withLock releases the name when the work throws", async () => {
      await caught(db.withLock("probe-fail", async () => Promise.reject(new Error("x"))));
      await expect(db.withLock("probe-fail", async () => "again")).resolves.toBe("again");
    });
  });

  describe("compatibility boundaries (asserted per dialect on purpose)", () => {
    it("timestamps: Date goes in as UTC; asDate() reads both a Date (MySQL) and ISO text (SQLite)", async () => {
      const when = new Date("2026-11-14T00:00:00.123Z");
      await db.query(`INSERT INTO ${stamps} (id, at) VALUES (?, ?)`, [1, when]);
      const raw = (await db.query<{ at: unknown }>(`SELECT at FROM ${stamps} WHERE id = ?`, [1])).rows[0]?.at;
      expect(raw instanceof Date).toBe(dialect === "mysql");
      expect(asDate(raw).toISOString()).toBe(when.toISOString());
    });

    it("integers beyond 2^53: MySQL returns a string, SQLite cannot read them", async () => {
      await db.query(`INSERT INTO ${stamps} (id, at, big) VALUES (?, ?, ?)`, [2, new Date(0), 9007199254740993n]);
      const read = () => db.query<{ big: unknown }>(`SELECT big FROM ${stamps} WHERE id = ?`, [2]);
      if (dialect === "mysql") expect((await read()).rows[0]?.big).toBe("9007199254740993");
      else expect(await caught(read())).toBeInstanceOf(DatabaseError);
    });

    it("booleans read back as 0 and 1 on both", async () => {
      expect((await db.query<{ t: unknown; f: unknown }>("SELECT (1 = 1) AS t, (1 = 2) AS f")).rows[0]).toEqual({ t: 1, f: 0 });
    });

    it("text equality: MySQL ignores case, SQLite does not (so code must normalise)", async () => {
      await insert("CaseProbe");
      expect(await count("caseprobe")).toBe(dialect === "mysql" ? 1 : 0);
    });

    it("row locks: only MySQL has FOR UPDATE", async () => {
      expect(db.supportsRowLocks).toBe(dialect === "mysql");
      const locked = caught(db.transaction((tx) => tx.query(`SELECT id FROM ${items} WHERE name = ? FOR UPDATE`, ["CaseProbe"])));
      if (dialect === "mysql") expect(await locked).toBeUndefined();
      else expect(await locked).toMatchObject({ kind: "query_failed" });
    });
  });
});
