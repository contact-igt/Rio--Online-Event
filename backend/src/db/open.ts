import type { DatabaseConfig } from "../config.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { openMysql } from "./mysql.ts";
import { openSqlite } from "./sqlite.ts";

// Takes a configuration that loadConfig() already validated (allowed host, no SQLite in production, test databases only under NODE_ENV=test).
// Nothing here relaxes those rules; there is deliberately no way to build an adapter from a raw URL.
export function openDatabase(config: DatabaseConfig): DatabaseAdapter {
  return config.dialect === "mysql" ? openMysql(config) : openSqlite(config);
}
