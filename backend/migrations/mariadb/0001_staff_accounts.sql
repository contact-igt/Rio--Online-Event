-- MariaDB 10.4 variant of the MySQL 8 migration of the same name, for LOCAL DEVELOPMENT on XAMPP only (production is MySQL 8).
-- Same tables, keys, checks, triggers and views. The only change is the two collation names MariaDB does not have:
--   utf8mb4_0900_bin   -> utf8mb4_nopad_bin    (exact code-point comparison with no trailing-space padding: the same comparison)
--   utf8mb4_0900_ai_ci -> utf8mb4_unicode_ci    (display text only; never part of a key or a rule)
-- NOT YET RUN on a real MariaDB server: see backend/LOCAL_DEVELOPMENT.md and backend/migrations/README.md.
-- Staff accounts (administrators and judges). Parents have no account: see 0005_submissions.
-- Passwords are stored only as a hash chosen by the Auth module (M3); sessions only as a SHA-256 digest of the cookie token.
CREATE TABLE IF NOT EXISTS staff_users (
  id BIGINT NOT NULL AUTO_INCREMENT,
  email VARCHAR(254) COLLATE utf8mb4_nopad_bin NOT NULL,
  password_hash VARCHAR(255) COLLATE utf8mb4_nopad_bin NOT NULL,
  role VARCHAR(10) COLLATE utf8mb4_nopad_bin NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  must_change_password TINYINT(1) NOT NULL DEFAULT 1,
  failed_logins SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until DATETIME(3) NULL,
  password_changed_at DATETIME(3) NULL,
  last_login_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY staff_users_email_uq (email),
  UNIQUE KEY staff_users_id_role_uq (id, role),
  CONSTRAINT staff_users_role_ck CHECK (role IN ('admin', 'judge')),
  CONSTRAINT staff_users_email_ck CHECK (email = LOWER(email) AND email REGEXP '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'),
  CONSTRAINT staff_users_hash_ck CHECK (CHAR_LENGTH(password_hash) >= 20),
  CONSTRAINT staff_users_name_ck CHECK (CHAR_LENGTH(TRIM(display_name)) >= 1),
  CONSTRAINT staff_users_flags_ck CHECK (active IN (0, 1) AND must_change_password IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS staff_sessions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  staff_id BIGINT NOT NULL,
  token_sha256 CHAR(64) COLLATE utf8mb4_nopad_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  expires_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY staff_sessions_token_uq (token_sha256),
  KEY staff_sessions_staff_idx (staff_id, revoked_at),
  KEY staff_sessions_expiry_idx (expires_at),
  CONSTRAINT staff_sessions_staff_fk FOREIGN KEY (staff_id) REFERENCES staff_users (id),
  CONSTRAINT staff_sessions_token_ck CHECK (token_sha256 REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT staff_sessions_expiry_ck CHECK (expires_at > created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
