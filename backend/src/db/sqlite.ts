import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Kysely, SqliteDialect, type SqliteDatabase } from "kysely";
import type { SqliteConfig } from "../config.ts";
import type { DatabaseAdapter, DatabaseSchema } from "./adapter.ts";
import { createAdapter } from "./kysely-adapter.ts";

// Local development database, using the SQLite that ships with Node (no native add-on to build). The file is opened on first use.
// SQLite is for development and tests only: config.ts refuses it in production.

function openDatabase(path: string): SqliteDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;${path === ":memory:" ? "" : " PRAGMA journal_mode = WAL;"}`);
  // Adapts node:sqlite to the small interface Kysely expects (the shape better-sqlite3 has).
  return {
    close: () => db.close(),
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        reader: statement.columns().length > 0,
        all: (parameters) => statement.all(...(parameters as SQLInputValue[])),
        run: (parameters) => statement.run(...(parameters as SQLInputValue[])),
        iterate: (parameters) => statement.iterate(...(parameters as SQLInputValue[])) as IterableIterator<unknown>,
      };
    },
  };
}

export function openSqlite(config: SqliteConfig): DatabaseAdapter {
  const kysely = new Kysely<DatabaseSchema>({ dialect: new SqliteDialect({ database: async () => openDatabase(config.path) }) });
  return createAdapter({ dialect: "sqlite", kysely, supportsRowLocks: false });
}
