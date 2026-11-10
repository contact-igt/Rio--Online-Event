import type { DatabaseAdapter, Queryable } from "../db/adapter.ts";
import { asDate } from "../db/values.ts";
import { newToken, sha256Hex, TOKEN_PATTERN } from "./tokens.ts";

// Database-backed sessions (table staff_sessions). Nothing about a session is trusted from the cookie except the random token: on every
// request the session row, the account's `active` flag and its role are read again, so a revoked session, a deactivated judge or a changed
// role takes effect on the very next request.

export type StaffRole = "admin" | "judge";

export type StaffSession = {
  sessionId: number;
  staffId: number;
  email: string;
  displayName: string;
  role: StaffRole;
  mustChangePassword: boolean;
  /** The raw cookie value, kept in memory for this request only (it is needed to check the CSRF token). */
  token: string;
  expiresAt: Date;
  /** When the session ends if it is not used again. */
  idleExpiresAt: Date;
};

/** How often a busy session writes its last-seen time, so reading a page does not become a database write every time. */
const TOUCH_AFTER_MS = 60_000;

export async function createSession(q: Queryable, staffId: number, now: Date, ttlMs: number): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(now.getTime() + ttlMs);
  await q.query("INSERT INTO staff_sessions (staff_id, token_sha256, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)", [staffId, sha256Hex(token), now, expiresAt, now]);
  return { token, expiresAt };
}

type Row = {
  session_id: number | string;
  created_at: unknown;
  expires_at: unknown;
  last_seen_at: unknown;
  id: number | string;
  email: string;
  display_name: string;
  role: string;
  active: number;
  must_change_password: number;
};

export async function findSession(db: DatabaseAdapter, token: string, now: Date, idleMs: number): Promise<StaffSession | null> {
  if (!TOKEN_PATTERN.test(token)) return null; // not something we issued: skip the database
  const { rows } = await db.query<Row>(
    `SELECT s.id AS session_id, s.created_at, s.expires_at, s.last_seen_at, u.id, u.email, u.display_name, u.role, u.active, u.must_change_password
     FROM staff_sessions s JOIN staff_users u ON u.id = s.staff_id
     WHERE s.token_sha256 = ? AND s.revoked_at IS NULL`,
    [sha256Hex(token)],
  );
  const row = rows[0];
  if (!row || Number(row.active) !== 1 || (row.role !== "admin" && row.role !== "judge")) return null;
  const expiresAt = asDate(row.expires_at);
  const lastSeen = asDate(row.last_seen_at ?? row.created_at);
  const idleExpiresAt = new Date(Math.min(lastSeen.getTime() + idleMs, expiresAt.getTime()));
  if (now.getTime() >= idleExpiresAt.getTime()) return null;
  if (now.getTime() - lastSeen.getTime() > TOUCH_AFTER_MS) {
    await db.query("UPDATE staff_sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL", [now, Number(row.session_id)]);
  }
  return {
    sessionId: Number(row.session_id),
    staffId: Number(row.id),
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    mustChangePassword: Number(row.must_change_password) === 1,
    token,
    expiresAt,
    idleExpiresAt: new Date(Math.min(now.getTime() + idleMs, expiresAt.getTime())),
  };
}

export async function revokeSession(q: Queryable, sessionId: number, now: Date): Promise<void> {
  await q.query("UPDATE staff_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now, sessionId]);
}

export async function revokeSessionByToken(q: Queryable, token: string, now: Date): Promise<void> {
  if (TOKEN_PATTERN.test(token)) await q.query("UPDATE staff_sessions SET revoked_at = ? WHERE token_sha256 = ? AND revoked_at IS NULL", [now, sha256Hex(token)]);
}

/** Ends every session of one account (password change or reset, deactivation). Returns how many were open. */
export async function revokeAllSessions(q: Queryable, staffId: number, now: Date): Promise<number> {
  return (await q.query("UPDATE staff_sessions SET revoked_at = ? WHERE staff_id = ? AND revoked_at IS NULL", [now, staffId])).affectedRows;
}
