import type { DatabaseAdapter } from "../db/adapter.ts";
import { sha256Hex } from "./tokens.ts";

// Fixed-window counters in the shared database (table rate_limits), so every server instance and every restart sees the same count. The
// limited value (an IP address, an e-mail address, a staff id) is stored only as a SHA-256 digest. The increment is a single atomic upsert that
// hands back THIS request's own count (MySQL: LAST_INSERT_ID(hits + 1) read on the same connection; SQLite: RETURNING), so in a burst of
// simultaneous requests exactly the first `max` are admitted, instead of every request seeing the final total and all being refused.

export type Hit = { hits: number; retryAfterSeconds: number };

export type RateLimiter = {
  hit(scope: string, value: string, windowMs: number, now: Date): Promise<Hit>;
  /** Forget the counter of one value (for example after a successful login). */
  clear(scope: string, value: string): Promise<void>;
  /** Remove windows that ended before `before`; run from a scheduled job. Returns the number of rows removed. */
  purge(before: Date): Promise<number>;
};

export function createRateLimiter(db: DatabaseAdapter): RateLimiter {
  const mysqlUpsert = "INSERT INTO rate_limits (scope, key_sha256, window_start, hits) VALUES (?, ?, ?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE hits = LAST_INSERT_ID(hits + 1)";
  const sqliteUpsert = "INSERT INTO rate_limits (scope, key_sha256, window_start, hits) VALUES (?, ?, ?, 1) ON CONFLICT (scope, key_sha256, window_start) DO UPDATE SET hits = hits + 1 RETURNING hits";
  return {
    async hit(scope, value, windowMs, now) {
      const key = sha256Hex(value);
      const start = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
      const hits =
        db.dialect === "mysql"
          ? await db.withConnection(async (c) => {
              await c.query(mysqlUpsert, [scope, key, start]);
              return Number((await c.query<{ hits: number | string }>("SELECT LAST_INSERT_ID() AS hits")).rows[0]!.hits);
            })
          : Number((await db.query<{ hits: number | string }>(sqliteUpsert, [scope, key, start])).rows[0]!.hits);
      return { hits, retryAfterSeconds: Math.max(1, Math.ceil((start.getTime() + windowMs - now.getTime()) / 1000)) };
    },
    async clear(scope, value) {
      await db.query("DELETE FROM rate_limits WHERE scope = ? AND key_sha256 = ?", [scope, sha256Hex(value)]);
    },
    async purge(before) {
      return (await db.query("DELETE FROM rate_limits WHERE window_start < ?", [before])).affectedRows;
    },
  };
}
