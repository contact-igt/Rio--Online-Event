import type { Kysely } from "kysely";
import type { Tables } from "./schema.ts";

// Database adapter contract, implemented once per dialect (MySQL 8 for production, SQLite for local development) so services never import
// a driver. The typed schema (schema.ts) describes the tables created by migrations 0001 to 0010.
//
// Rules every implementation keeps:
//  - values are always passed as parameters, never concatenated into SQL;
//  - a transaction commits when the callback resolves and rolls back when it throws; an error thrown by the callback comes out unchanged;
//  - every database failure is a DatabaseError (db/errors.ts): a fixed kind, never the driver's text, SQL, host or credentials;
//  - `affectedRows` counts rows MATCHED by an UPDATE on both dialects (MySQL is opened with FOUND_ROWS to match SQLite).
//
// Differences code must respect (each is pinned by a test in adapter.test.ts):
//  - timestamps go in as Date (stored as UTC). MySQL DATETIME comes back as a Date; SQLite has no date type and returns the ISO text, so
//    read every timestamp through asDate() (values.ts);
//  - integers beyond 2^53: MySQL returns them as strings, SQLite cannot read them at all (the query fails). Keep ids, counters and sizes
//    inside the safe range and store anything larger as text;
//  - booleans come back as 0 and 1 on both;
//  - MySQL compares text case-insensitively (utf8mb4_0900_ai_ci), SQLite case-sensitively: normalise (lower-case, NFC) in code, never rely on the engine;
//  - `FOR UPDATE` exists on MySQL only (see supportsRowLocks);
//  - MySQL commits DDL implicitly; SQLite can roll it back.

export type Dialect = "mysql" | "sqlite";
export type SqlValue = string | number | bigint | boolean | null | Date | Uint8Array;
export type DatabaseSchema = Tables;

export type QueryResult<Row> = {
  rows: Row[];
  /** Rows matched by INSERT, UPDATE or DELETE; 0 for SELECT. */
  affectedRows: number;
};

export interface Queryable {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly SqlValue[]): Promise<QueryResult<Row>>;
}

/** A unit of work. Statements run on one connection, so `SELECT ... FOR UPDATE` row locks (MySQL) hold until the transaction ends. */
export interface Transaction extends Queryable {
  readonly dialect: Dialect;
  /** The same transaction for type-safe query building. */
  readonly kysely: Kysely<DatabaseSchema>;
}

export interface DatabaseAdapter extends Queryable {
  readonly dialect: Dialect;
  /** The type-safe query builder on the same pool. */
  readonly kysely: Kysely<DatabaseSchema>;
  /**
   * Whether row locks (`FOR UPDATE`) exist. SQLite has none (it locks the whole database per write transaction), so code that relies on
   * row locks for correctness must be proven on MySQL, not only on SQLite.
   */
  readonly supportsRowLocks: boolean;
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Runs `work` on one dedicated connection, outside a transaction (session settings, DDL that needs one connection). */
  withConnection<T>(work: (connection: Queryable) => Promise<T>): Promise<T>;
  /** Mutual exclusion by name: MySQL uses a server-side named lock, SQLite an in-process queue. Used by the migration runner. */
  withLock<T>(name: string, work: () => Promise<T>): Promise<T>;
  /** Cheap round trip used by readiness checks. */
  ping(): Promise<void>;
  /** Closes the pool. Safe to call more than once. */
  close(): Promise<void>;
}
