import type { Dialect } from "./adapter.ts";

// Driver errors carry the SQL text, parameters, host names and sometimes user names. None of that may leave the database layer, so every
// failure is reduced to a fixed kind. The original error is not kept (not even as `cause`), because logging libraries follow causes.

export type DatabaseErrorKind =
  | "unavailable" // cannot reach the server or the connection was lost
  | "misconfigured" // reached the server but credentials or database name are refused
  | "timeout"
  | "deadlock"
  | "busy" // SQLite database locked by another writer
  | "constraint"
  | "query_failed";
// "rule" is a business rule enforced by a trigger (SIGNAL on MySQL, RAISE on SQLite), as opposed to a declarative constraint.
export type ConstraintKind = "unique" | "foreign_key" | "check" | "not_null" | "rule" | "other";

export class DatabaseError extends Error {
  override name = "DatabaseError";
  readonly kind: DatabaseErrorKind;
  readonly constraint: ConstraintKind | null;
  /** Safe to run the whole unit of work again. */
  readonly retryable: boolean;
  /** The logger keeps `name` and `code` of an error, so the kind is exposed as the code. */
  readonly code: DatabaseErrorKind;
  constructor(kind: DatabaseErrorKind, constraint: ConstraintKind | null = null) {
    super(`Database error: ${kind}${constraint ? ` (${constraint})` : ""}`);
    this.kind = kind;
    this.code = kind;
    this.constraint = constraint;
    this.retryable = kind === "deadlock" || kind === "busy";
  }
}

type Raw = { code?: unknown; errno?: unknown; errcode?: unknown; errors?: unknown };

const MYSQL_UNAVAILABLE = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "PROTOCOL_CONNECTION_LOST", "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR", "PROTOCOL_ENQUEUE_AFTER_QUIT", "POOL_CLOSED"]);
const MYSQL_TIMEOUT = new Set(["ETIMEDOUT", "PROTOCOL_SEQUENCE_TIMEOUT"]);

function mysql(raw: Raw): DatabaseError {
  const code = typeof raw.code === "string" ? raw.code : "";
  const errno = typeof raw.errno === "number" ? raw.errno : 0;
  if (errno === 1062) return new DatabaseError("constraint", "unique");
  if (errno === 1451 || errno === 1452) return new DatabaseError("constraint", "foreign_key");
  if (errno === 3819 || errno === 4025) return new DatabaseError("constraint", "check"); // 3819: MySQL 8, 4025: MariaDB
  if (errno === 1644) return new DatabaseError("constraint", "rule"); // SIGNAL SQLSTATE 45000 from a trigger
  if (errno === 1048 || errno === 1364) return new DatabaseError("constraint", "not_null");
  if (errno === 1406 || errno === 1264) return new DatabaseError("constraint", "other"); // value too long / out of range
  if (errno === 1213) return new DatabaseError("deadlock");
  if (errno === 1205 || errno === 3024 || MYSQL_TIMEOUT.has(code)) return new DatabaseError("timeout");
  if (errno === 1044 || errno === 1045 || errno === 1049) return new DatabaseError("misconfigured");
  if (errno === 1040 || errno === 1053 || errno === 1927 || MYSQL_UNAVAILABLE.has(code)) return new DatabaseError("unavailable");
  // Several addresses tried (for example localhost -> ::1 and 127.0.0.1) arrive as an AggregateError holding the real errors.
  if (Array.isArray(raw.errors) && raw.errors.length > 0) return mysql(raw.errors[0] as Raw);
  return new DatabaseError("query_failed");
}

// SQLite result codes: https://www.sqlite.org/rescode.html. The low byte is the primary code; the full value is the extended code.
function sqlite(raw: Raw): DatabaseError {
  const extended = typeof raw.errcode === "number" ? raw.errcode : 0;
  switch (extended & 0xff) {
    case 19:
      if (extended === 2067 || extended === 1555) return new DatabaseError("constraint", "unique");
      if (extended === 787) return new DatabaseError("constraint", "foreign_key");
      if (extended === 275) return new DatabaseError("constraint", "check");
      if (extended === 1299) return new DatabaseError("constraint", "not_null");
      if (extended === 1811) return new DatabaseError("constraint", "rule"); // RAISE() from a trigger
      return new DatabaseError("constraint", "other");
    case 5:
    case 6:
      return new DatabaseError("busy");
    case 10: // I/O error
    case 11: // corrupt
    case 13: // disk full
    case 14: // cannot open
    case 26: // not a database
      return new DatabaseError("unavailable");
    default:
      return new DatabaseError("query_failed");
  }
}

export function sanitizeDatabaseError(dialect: Dialect, error: unknown): DatabaseError {
  if (error instanceof DatabaseError) return error;
  const raw: Raw = typeof error === "object" && error !== null ? (error as Raw) : {};
  return dialect === "mysql" ? mysql(raw) : sqlite(raw);
}
