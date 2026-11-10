-- Outgoing confirmation e-mails (the recipient is read from the entry when sending; no address is copied here) and fixed-window rate-limit counters.
-- rate_limits stores only a SHA-256 digest of the limited key (an IP address, a mobile number or a recovery code attempt), never the key.
CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  locked_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sent_at TEXT,
  CONSTRAINT email_outbox_once_uq UNIQUE (submission_id, kind),
  CONSTRAINT email_outbox_submission_fk FOREIGN KEY (submission_id) REFERENCES submissions (id),
  CONSTRAINT email_outbox_kind_ck CHECK (kind IN ('participation')),
  CONSTRAINT email_outbox_status_ck CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'abandoned')),
  CONSTRAINT email_outbox_attempts_ck CHECK (attempts BETWEEN 0 AND 8),
  CONSTRAINT email_outbox_error_ck CHECK (last_error IS NULL OR last_error IN ('transient', 'permanent')),
  CONSTRAINT email_outbox_sent_ck CHECK ((status = 'sent') = (sent_at IS NOT NULL))
) STRICT
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_outbox_due_idx ON email_outbox (status, next_attempt_at)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS rate_limits (
  scope TEXT NOT NULL,
  key_sha256 TEXT NOT NULL,
  window_start TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (scope, key_sha256, window_start),
  CONSTRAINT rate_limits_scope_ck CHECK (length(scope) BETWEEN 2 AND 40 AND scope GLOB '[a-z]*' AND scope NOT GLOB '*[^a-z0-9_.]*'),
  CONSTRAINT rate_limits_key_ck CHECK (length(key_sha256) = 64 AND key_sha256 NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT rate_limits_hits_ck CHECK (hits >= 1)
) STRICT, WITHOUT ROWID
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rate_limits_window_idx ON rate_limits (window_start)
