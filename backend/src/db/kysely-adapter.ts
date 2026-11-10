import { CompiledQuery, type Kysely } from "kysely";
import type { DatabaseAdapter, DatabaseSchema, Dialect, Queryable, QueryResult, SqlValue, Transaction } from "./adapter.ts";
import { DatabaseError, sanitizeDatabaseError } from "./errors.ts";

// The one implementation of the adapter contract. MySQL and SQLite differ only in how the Kysely instance is built (mysql.ts, sqlite.ts),
// in how parameters are encoded, and in how a named lock works; everything else, including error sanitisation, is shared so that both
// dialects behave the same way under test.

type Executor = Pick<Kysely<DatabaseSchema>, "executeQuery">;

function encode(dialect: Dialect, value: SqlValue | undefined): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Uint8Array) return dialect === "mysql" ? Buffer.from(value) : value;
  if (dialect === "sqlite") {
    if (value instanceof Date) return value.toISOString(); // SQLite has no date type; UTC text sorts correctly
    if (typeof value === "boolean") return value ? 1 : 0;
  }
  return value; // mysql2 serialises Date (as UTC, see mysql.ts) and booleans itself
}

export function createAdapter(options: { dialect: Dialect; kysely: Kysely<DatabaseSchema>; supportsRowLocks: boolean }): DatabaseAdapter {
  const { dialect, kysely, supportsRowLocks } = options;

  const run = async <Row>(executor: Executor, sql: string, params: readonly SqlValue[] = []): Promise<QueryResult<Row>> => {
    try {
      const result = await executor.executeQuery(CompiledQuery.raw(sql, params.map((p) => encode(dialect, p))));
      return { rows: result.rows.map((r) => ({ ...(r as object) }) as Row), affectedRows: Number(result.numAffectedRows ?? 0) };
    } catch (error) {
      throw sanitizeDatabaseError(dialect, error);
    }
  };
  const queryable = (executor: Executor): Queryable => ({ query: (sql, params) => run(executor, sql, params) });

  // Runs `body` and sanitises failures of the machinery around it (begin, commit, pool) while letting the caller's own errors through unchanged.
  async function guarded<T>(body: (own: (e: unknown) => void) => Promise<T>): Promise<T> {
    let own: unknown;
    let ownSet = false;
    try {
      return await body((e) => {
        own = e;
        ownSet = true;
      });
    } catch (error) {
      if (ownSet && error === own) throw error;
      throw sanitizeDatabaseError(dialect, error);
    }
  }
  const keepOwn = async <T>(work: () => Promise<T>, mark: (e: unknown) => void): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      mark(error);
      throw error;
    }
  };

  const queues = new Map<string, Promise<unknown>>();
  async function withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
    if (dialect === "sqlite") {
      // One process owns a SQLite file in this project, so a queue is enough; the file's own write lock covers any stray second process.
      const previous = queues.get(name) ?? Promise.resolve();
      const mine = previous.catch(() => undefined).then(work);
      queues.set(name, mine);
      try {
        return await mine;
      } finally {
        if (queues.get(name) === mine) queues.delete(name);
      }
    }
    const lockName = `rio:${name}`.slice(0, 64);
    return adapter.withConnection(async (connection) => {
      const got = await connection.query<{ got: number | string | null }>("SELECT GET_LOCK(?, 30) AS got", [lockName]);
      if (Number(got.rows[0]?.got) !== 1) throw new DatabaseError("timeout");
      try {
        return await work();
      } finally {
        await connection.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => undefined);
      }
    });
  }

  let closed = false;
  const adapter: DatabaseAdapter = {
    dialect,
    kysely,
    supportsRowLocks,
    query: (sql, params) => run(kysely, sql, params),
    transaction: <T>(work: (tx: Transaction) => Promise<T>) =>
      guarded((mark) =>
        kysely.transaction().execute((trx) => keepOwn(() => work({ dialect, kysely: trx, ...queryable(trx) }), mark)),
      ),
    withConnection: <T>(work: (connection: Queryable) => Promise<T>) =>
      guarded((mark) => kysely.connection().execute((conn) => keepOwn(() => work(queryable(conn)), mark))),
    withLock,
    async ping() {
      await run(kysely, "SELECT 1");
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await kysely.destroy();
      } catch (error) {
        throw sanitizeDatabaseError(dialect, error);
      }
    },
  };
  return adapter;
}
