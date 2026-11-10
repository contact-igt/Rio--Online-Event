-- Outgoing confirmation e-mails (the recipient is read from the entry when sending; no address is copied here) and fixed-window rate-limit counters.
-- rate_limits stores only a SHA-256 digest of the limited key (an IP address, a mobile number or a recovery code attempt), never the key.
CREATE TABLE IF NOT EXISTS email_outbox (
  id BIGINT NOT NULL AUTO_INCREMENT,
  submission_id BIGINT NOT NULL,
  kind VARCHAR(20) COLLATE utf8mb4_0900_bin NOT NULL,
  status VARCHAR(10) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'pending',
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  locked_until DATETIME(3) NULL,
  last_error VARCHAR(10) COLLATE utf8mb4_0900_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  sent_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY email_outbox_once_uq (submission_id, kind),
  KEY email_outbox_due_idx (status, next_attempt_at),
  CONSTRAINT email_outbox_submission_fk FOREIGN KEY (submission_id) REFERENCES submissions (id),
  CONSTRAINT email_outbox_kind_ck CHECK (kind IN ('participation')),
  CONSTRAINT email_outbox_status_ck CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'abandoned')),
  CONSTRAINT email_outbox_attempts_ck CHECK (attempts <= 8),
  CONSTRAINT email_outbox_error_ck CHECK (last_error IS NULL OR last_error IN ('transient', 'permanent')),
  CONSTRAINT email_outbox_sent_ck CHECK ((status = 'sent') = (sent_at IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS rate_limits (
  scope VARCHAR(40) COLLATE utf8mb4_0900_bin NOT NULL,
  key_sha256 CHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
  window_start DATETIME(3) NOT NULL,
  hits INT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (scope, key_sha256, window_start),
  KEY rate_limits_window_idx (window_start),
  CONSTRAINT rate_limits_scope_ck CHECK (scope REGEXP '^[a-z][a-z0-9_.]{1,39}$'),
  CONSTRAINT rate_limits_key_ck CHECK (key_sha256 REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT rate_limits_hits_ck CHECK (hits >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
