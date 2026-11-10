-- One row per child entry in one competition. No parent account exists: the guardian is described by the static fields below, and an
-- unfinished entry is reopened with a recovery token (stored only as a SHA-256 digest).
-- Names are kept as typed (child_name) and in an application-normalised form (child_name_norm, NFC, case-folded, spaces collapsed): the
-- database never transliterates or normalises Tamil text itself, and SQLite's default BINARY collation compares code points exactly.
-- Mobile numbers are stored as +91 followed by ten digits.
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_code TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  question_set_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  child_name TEXT NOT NULL,
  child_name_norm TEXT NOT NULL,
  child_age INTEGER NOT NULL,
  guardian_name TEXT NOT NULL,
  guardian_mobile TEXT NOT NULL,
  guardian_email TEXT NOT NULL,
  guardian_consent_version TEXT,
  guardian_consent_at TEXT,
  media_consent INTEGER,
  media_consent_version TEXT,
  media_consent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  submitted_at TEXT,
  finalized_at TEXT,
  withdrawn_at TEXT,
  finalized_flag INTEGER GENERATED ALWAYS AS (CASE WHEN status = 'finalized' THEN 1 END) STORED,
  CONSTRAINT submissions_entry_code_uq UNIQUE (entry_code),
  CONSTRAINT submissions_id_event_uq UNIQUE (id, event_id),
  CONSTRAINT submissions_id_set_uq UNIQUE (id, question_set_id),
  CONSTRAINT submissions_one_finalized_uq UNIQUE (event_id, child_name_norm, guardian_mobile, finalized_flag),
  CONSTRAINT submissions_event_fk FOREIGN KEY (event_id) REFERENCES events (id),
  CONSTRAINT submissions_set_fk FOREIGN KEY (question_set_id, event_id) REFERENCES question_sets (id, event_id),
  CONSTRAINT submissions_status_ck CHECK (status IN ('draft', 'held', 'finalized', 'withdrawn', 'rejected')),
  CONSTRAINT submissions_code_ck CHECK (length(entry_code) BETWEEN 6 AND 16 AND entry_code NOT GLOB '*[^A-Z0-9]*'),
  CONSTRAINT submissions_child_ck CHECK (
    length(trim(child_name)) BETWEEN 1 AND 80 AND length(child_name) <= 80 AND length(child_name_norm) BETWEEN 1 AND 160 AND child_age BETWEEN 1 AND 18
  ),
  CONSTRAINT submissions_guardian_ck CHECK (length(trim(guardian_name)) BETWEEN 1 AND 80 AND length(guardian_name) <= 80),
  CONSTRAINT submissions_mobile_ck CHECK (
    length(guardian_mobile) = 13 AND substr(guardian_mobile, 1, 3) = '+91' AND substr(guardian_mobile, 4, 1) IN ('6', '7', '8', '9') AND substr(guardian_mobile, 4) NOT GLOB '*[^0-9]*'
  ),
  CONSTRAINT submissions_email_ck CHECK (
    length(guardian_email) <= 254 AND guardian_email = lower(guardian_email) AND guardian_email LIKE '_%@_%._%' AND guardian_email NOT LIKE '% %'
    AND length(guardian_email) - length(replace(guardian_email, '@', '')) = 1
  ),
  CONSTRAINT submissions_guardian_consent_ck CHECK (
    (guardian_consent_version IS NULL) = (guardian_consent_at IS NULL)
    AND (guardian_consent_version IS NULL OR (length(guardian_consent_version) BETWEEN 1 AND 40 AND guardian_consent_version NOT GLOB '*[^A-Za-z0-9._-]*'))
    AND (status NOT IN ('held', 'finalized') OR guardian_consent_at IS NOT NULL)
  ),
  CONSTRAINT submissions_media_consent_ck CHECK (
    (media_consent IS NULL OR media_consent IN (0, 1))
    AND (media_consent IS NULL) = (media_consent_at IS NULL)
    AND (media_consent IS NULL) = (media_consent_version IS NULL)
    AND (media_consent_version IS NULL OR (length(media_consent_version) BETWEEN 1 AND 40 AND media_consent_version NOT GLOB '*[^A-Za-z0-9._-]*'))
  ),
  CONSTRAINT submissions_stamps_ck CHECK (
    (status NOT IN ('held', 'finalized') OR submitted_at IS NOT NULL)
    AND (status <> 'finalized' OR finalized_at IS NOT NULL)
    AND (finalized_at IS NULL OR status IN ('finalized', 'withdrawn'))
    AND ((status = 'withdrawn') = (withdrawn_at IS NOT NULL))
  )
) STRICT
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS submissions_mobile_idx ON submissions (guardian_mobile)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS submissions_event_status_idx ON submissions (event_id, status)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS registration_recovery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  token_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  active_flag INTEGER GENERATED ALWAYS AS (CASE WHEN used_at IS NULL AND revoked_at IS NULL THEN 1 END) STORED,
  CONSTRAINT registration_recovery_token_uq UNIQUE (token_sha256),
  CONSTRAINT registration_recovery_one_active_uq UNIQUE (submission_id, active_flag),
  CONSTRAINT registration_recovery_submission_fk FOREIGN KEY (submission_id) REFERENCES submissions (id),
  CONSTRAINT registration_recovery_token_ck CHECK (length(token_sha256) = 64 AND token_sha256 NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT registration_recovery_expiry_ck CHECK (expires_at > created_at),
  CONSTRAINT registration_recovery_state_ck CHECK (used_at IS NULL OR revoked_at IS NULL),
  CONSTRAINT registration_recovery_attempts_ck CHECK (failed_attempts BETWEEN 0 AND 65535)
) STRICT
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS registration_recovery_expiry_idx ON registration_recovery (expires_at)
--> statement-breakpoint
DROP TRIGGER IF EXISTS submissions_guard_insert
--> statement-breakpoint
CREATE TRIGGER submissions_guard_insert BEFORE INSERT ON submissions FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: an entry starts as a draft') WHERE NEW.status <> 'draft';
  SELECT RAISE(ABORT, 'rule: the child age is outside the competition range')
  WHERE NEW.child_age < (SELECT min_age FROM events WHERE id = NEW.event_id) OR NEW.child_age > (SELECT max_age FROM events WHERE id = NEW.event_id);
  SELECT RAISE(ABORT, 'rule: an entry must use the published question set') WHERE (SELECT status FROM question_sets WHERE id = NEW.question_set_id) <> 'published';
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS submissions_guard_update
--> statement-breakpoint
CREATE TRIGGER submissions_guard_update BEFORE UPDATE ON submissions FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: this status change is not allowed')
  WHERE NEW.status <> OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('held', 'finalized', 'withdrawn'))
    OR (OLD.status = 'held' AND NEW.status IN ('finalized', 'rejected', 'withdrawn'))
    OR (OLD.status = 'finalized' AND NEW.status = 'withdrawn')
  );
  SELECT RAISE(ABORT, 'rule: a submitted entry cannot be edited')
  WHERE OLD.status <> 'draft' AND (
    NEW.entry_code <> OLD.entry_code OR NEW.event_id <> OLD.event_id OR NEW.question_set_id <> OLD.question_set_id
    OR NEW.child_name <> OLD.child_name OR NEW.child_name_norm <> OLD.child_name_norm OR NEW.child_age <> OLD.child_age
    OR NEW.guardian_name <> OLD.guardian_name OR NEW.guardian_mobile <> OLD.guardian_mobile OR NEW.guardian_email <> OLD.guardian_email
    OR NEW.guardian_consent_version IS NOT OLD.guardian_consent_version OR NEW.guardian_consent_at IS NOT OLD.guardian_consent_at
    OR NEW.media_consent IS NOT OLD.media_consent OR NEW.media_consent_version IS NOT OLD.media_consent_version OR NEW.media_consent_at IS NOT OLD.media_consent_at
    OR NEW.submitted_at IS NOT OLD.submitted_at
  );
  SELECT RAISE(ABORT, 'rule: the child age is outside the competition range')
  WHERE OLD.status = 'draft' AND (NEW.child_age <> OLD.child_age OR NEW.event_id <> OLD.event_id)
    AND (NEW.child_age < (SELECT min_age FROM events WHERE id = NEW.event_id) OR NEW.child_age > (SELECT max_age FROM events WHERE id = NEW.event_id));
  SELECT RAISE(ABORT, 'rule: an entry must use the published question set')
  WHERE OLD.status = 'draft' AND NEW.question_set_id <> OLD.question_set_id AND (SELECT status FROM question_sets WHERE id = NEW.question_set_id) <> 'published';
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS submissions_guard_delete
--> statement-breakpoint
CREATE TRIGGER submissions_guard_delete BEFORE DELETE ON submissions FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: a submitted entry cannot be deleted; withdraw it first') WHERE OLD.status IN ('held', 'finalized');
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS registration_recovery_guard_insert
--> statement-breakpoint
CREATE TRIGGER registration_recovery_guard_insert BEFORE INSERT ON registration_recovery FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: only an unfinished entry can be recovered') WHERE (SELECT status FROM submissions WHERE id = NEW.submission_id) <> 'draft';
END
