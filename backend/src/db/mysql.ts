import { Kysely, MysqlDialect } from "kysely";
import { createPool } from "mysql2";
import type { MysqlConfig } from "../config.ts";
import type { DatabaseAdapter, DatabaseSchema } from "./adapter.ts";
import { createAdapter } from "./kysely-adapter.ts";

// MySQL 8 through a mysql2 connection pool. Creating the adapter does not connect: the pool opens connections on first use, so a wrong
// host shows up as a sanitised `unavailable` error on the first query or ping, never as a crash at import time.

// The MySQL 8 defaults, spelled out so a server with a looser global mode cannot make a bad write succeed (strict tables, no zero dates).
const SESSION_SQL =
  "SET SESSION sql_mode = 'ONLY_FULL_GROUP_BY,STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION', time_zone = '+00:00'";

export function openMysql(config: MysqlConfig): DatabaseAdapter {
  const pool = createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: config.poolSize,
    connectTimeout: config.connectTimeoutMs,
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
    charset: "utf8mb4",
    timezone: "Z", // Date values travel as UTC
    supportBigNumbers: true, // 64-bit integers beyond 2^53 come back as strings instead of losing digits
    bigNumberStrings: false,
    multipleStatements: false, // one statement per call: an injected second statement cannot run
    flags: ["+FOUND_ROWS"], // affectedRows counts matched rows, as SQLite does
  });
  // Runs before the connection is handed out; a connection that cannot be configured is discarded.
  pool.on("connection", (connection) => {
    connection.query(SESSION_SQL, (error) => {
      if (error) connection.destroy();
    });
  });
  const kysely = new Kysely<DatabaseSchema>({ dialect: new MysqlDialect({ pool }) });
  return createAdapter({ dialect: "mysql", kysely, supportsRowLocks: true });
}
