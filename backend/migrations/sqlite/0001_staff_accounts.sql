-- Staff accounts (administrators and judges). Parents have no account: see 0005_submissions.
-- Passwords are stored only as a hash chosen by the Auth module (M3); sessions only as a SHA-256 digest of the cookie token.
-- SQLite notes (all migrations in this folder): timestamps are UTC ISO-8601 text with milliseconds and a trailing Z, as the adapter writes them;
-- STRICT tables; VARCHAR limits are repeated as length() checks because SQLite does not enforce them.
CREATE TABLE IF NOT EXISTS staff_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  display_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  password_changed_at TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT staff_users_email_uq UNIQUE (email),
  CONSTRAINT staff_users_id_role_uq UNIQUE (id, role),
  CONSTRAINT staff_users_role_ck CHECK (role IN ('admin', 'judge')),
  CONSTRAINT staff_users_email_ck CHECK (
    length(email) <= 254 AND email = lower(email) AND email LIKE '_%@_%._%' AND email NOT LIKE '% %' AND length(email) - length(replace(email, '@', '')) = 1
  ),
  CONSTRAINT staff_users_hash_ck CHECK (length(password_hash) BETWEEN 20 AND 255),
  CONSTRAINT staff_users_name_ck CHECK (length(trim(display_name)) >= 1 AND length(display_name) <= 80),
  CONSTRAINT staff_users_flags_ck CHECK (active IN (0, 1) AND must_change_password IN (0, 1) AND failed_logins BETWEEN 0 AND 65535)
) STRICT
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS staff_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL,
  token_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  CONSTRAINT staff_sessions_token_uq UNIQUE (token_sha256),
  CONSTRAINT staff_sessions_staff_fk FOREIGN KEY (staff_id) REFERENCES staff_users (id),
  CONSTRAINT staff_sessions_token_ck CHECK (length(token_sha256) = 64 AND token_sha256 NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT staff_sessions_expiry_ck CHECK (expires_at > created_at)
) STRICT
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS staff_sessions_staff_idx ON staff_sessions (staff_id, revoked_at)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS staff_sessions_expiry_idx ON staff_sessions (expires_at)
