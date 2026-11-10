-- MariaDB 10.4 variant of the MySQL 8 migration of the same name, for LOCAL DEVELOPMENT on XAMPP only (production is MySQL 8).
-- Same tables, keys, checks, triggers and views. The only change is the two collation names MariaDB does not have:
--   utf8mb4_0900_bin   -> utf8mb4_nopad_bin    (exact code-point comparison with no trailing-space padding: the same comparison)
--   utf8mb4_0900_ai_ci -> utf8mb4_unicode_ci    (display text only; never part of a key or a rule)
-- NOT YET RUN on a real MariaDB server: see backend/LOCAL_DEVELOPMENT.md and backend/migrations/README.md.
-- One row per child entry in one competition. No parent account exists: the guardian is described by the static fields below, and an
-- unfinished entry is reopened with a recovery token (stored only as a SHA-256 digest).
-- Names are kept as typed (child_name) and in an application-normalised form (child_name_norm, NFC, case-folded, spaces collapsed): the
-- database never transliterates or normalises Tamil text itself, and the _bin collation compares code points exactly.
-- Mobile numbers are stored as +91 followed by ten digits.
CREATE TABLE IF NOT EXISTS submissions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  entry_code VARCHAR(16) COLLATE utf8mb4_nopad_bin NOT NULL,
  event_id SMALLINT NOT NULL,
  question_set_id BIGINT NOT NULL,
  status VARCHAR(10) COLLATE utf8mb4_nopad_bin NOT NULL DEFAULT 'draft',
  child_name VARCHAR(80) NOT NULL,
  child_name_norm VARCHAR(160) COLLATE utf8mb4_nopad_bin NOT NULL,
  child_age TINYINT UNSIGNED NOT NULL,
  guardian_name VARCHAR(80) NOT NULL,
  guardian_mobile CHAR(13) COLLATE utf8mb4_nopad_bin NOT NULL,
  guardian_email VARCHAR(254) COLLATE utf8mb4_nopad_bin NOT NULL,
  guardian_consent_version VARCHAR(40) COLLATE utf8mb4_nopad_bin NULL,
  guardian_consent_at DATETIME(3) NULL,
  media_consent TINYINT(1) NULL,
  media_consent_version VARCHAR(40) COLLATE utf8mb4_nopad_bin NULL,
  media_consent_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  submitted_at DATETIME(3) NULL,
  finalized_at DATETIME(3) NULL,
  withdrawn_at DATETIME(3) NULL,
  finalized_flag TINYINT GENERATED ALWAYS AS (IF(status = 'finalized', 1, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY submissions_entry_code_uq (entry_code),
  UNIQUE KEY submissions_id_event_uq (id, event_id),
  UNIQUE KEY submissions_id_set_uq (id, question_set_id),
  UNIQUE KEY submissions_one_finalized_uq (event_id, child_name_norm, guardian_mobile, finalized_flag),
  KEY submissions_mobile_idx (guardian_mobile),
  KEY submissions_event_status_idx (event_id, status),
  CONSTRAINT submissions_event_fk FOREIGN KEY (event_id) REFERENCES events (id),
  CONSTRAINT submissions_set_fk FOREIGN KEY (question_set_id, event_id) REFERENCES question_sets (id, event_id),
  CONSTRAINT submissions_status_ck CHECK (status IN ('draft', 'held', 'finalized', 'withdrawn', 'rejected')),
  CONSTRAINT submissions_code_ck CHECK (entry_code REGEXP '^[A-Z0-9]{6,16}$'),
  CONSTRAINT submissions_child_ck CHECK (CHAR_LENGTH(TRIM(child_name)) BETWEEN 1 AND 80 AND CHAR_LENGTH(child_name_norm) >= 1 AND child_age BETWEEN 1 AND 18),
  CONSTRAINT submissions_guardian_ck CHECK (CHAR_LENGTH(TRIM(guardian_name)) BETWEEN 1 AND 80),
  CONSTRAINT submissions_mobile_ck CHECK (guardian_mobile REGEXP '^[+]91[6-9][0-9]{9}$'),
  CONSTRAINT submissions_email_ck CHECK (guardian_email = LOWER(guardian_email) AND guardian_email REGEXP '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'),
  CONSTRAINT submissions_guardian_consent_ck CHECK (
    (guardian_consent_version IS NULL) = (guardian_consent_at IS NULL)
    AND (guardian_consent_version IS NULL OR guardian_consent_version REGEXP '^[A-Za-z0-9._-]{1,40}$')
    AND (status NOT IN ('held', 'finalized') OR guardian_consent_at IS NOT NULL)
  ),
  CONSTRAINT submissions_media_consent_ck CHECK (
    (media_consent IS NULL OR media_consent IN (0, 1))
    AND (media_consent IS NULL) = (media_consent_at IS NULL)
    AND (media_consent IS NULL) = (media_consent_version IS NULL)
    AND (media_consent_version IS NULL OR media_consent_version REGEXP '^[A-Za-z0-9._-]{1,40}$')
  ),
  CONSTRAINT submissions_stamps_ck CHECK (
    (status NOT IN ('held', 'finalized') OR submitted_at IS NOT NULL)
    AND (status <> 'finalized' OR finalized_at IS NOT NULL)
    AND (finalized_at IS NULL OR status IN ('finalized', 'withdrawn'))
    AND ((status = 'withdrawn') = (withdrawn_at IS NOT NULL))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS registration_recovery (
  id BIGINT NOT NULL AUTO_INCREMENT,
  submission_id BIGINT NOT NULL,
  token_sha256 CHAR(64) COLLATE utf8mb4_nopad_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  failed_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_attempt_at DATETIME(3) NULL,
  active_flag TINYINT GENERATED ALWAYS AS (IF(used_at IS NULL AND revoked_at IS NULL, 1, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY registration_recovery_token_uq (token_sha256),
  UNIQUE KEY registration_recovery_one_active_uq (submission_id, active_flag),
  KEY registration_recovery_expiry_idx (expires_at),
  CONSTRAINT registration_recovery_submission_fk FOREIGN KEY (submission_id) REFERENCES submissions (id),
  CONSTRAINT registration_recovery_token_ck CHECK (token_sha256 REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT registration_recovery_expiry_ck CHECK (expires_at > created_at),
  CONSTRAINT registration_recovery_state_ck CHECK (used_at IS NULL OR revoked_at IS NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
--> statement-breakpoint
DROP TRIGGER IF EXISTS submissions_guard_insert
--> statement-breakpoint
CREATE TRIGGER submissions_guard_insert BEFORE INSERT ON submissions FOR EACH ROW
BEGIN
  IF NEW.status <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: an entry starts as a draft';
  END IF;
  IF NEW.child_age < (SELECT min_age FROM events WHERE id = NEW.event_id) OR NEW.child_age > (SELECT max_age FROM events WHERE id = NEW.event_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: the child age is outside the competition range';
  END IF;
  IF (SELECT status FROM question_sets WHERE id = NEW.question_set_id) <> 'published' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: an entry must use the published question set';
  END IF;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS submissions_guard_update
--> statement-breakpoint
CREATE TRIGGER submissions_guard_update BEFORE UPDATE ON submissions FOR EACH ROW
BEGIN
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('held', 'finalized', 'withdrawn'))
    OR (OLD.status = 'held' AND NEW.status IN ('finalized', 'rejected', 'withdrawn'))
    OR (OLD.status = 'finalized' AND NEW.status = 'withdrawn')
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: this status change is not allowed';
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.entry_code <> OLD.entry_code OR NEW.event_id <> OLD.event_id OR NEW.question_set_id <> OLD.question_set_id
    OR NEW.child_name <> OLD.child_name OR NEW.child_name_norm <> OLD.child_name_norm OR NEW.child_age <> OLD.child_age
    OR NEW.guardian_name <> OLD.guardian_name OR NEW.guardian_mobile <> OLD.guardian_mobile OR NEW.guardian_email <> OLD.guardian_email
    OR NOT (NEW.guardian_consent_version <=> OLD.guardian_consent_version) OR NOT (NEW.guardian_consent_at <=> OLD.guardian_consent_at)
    OR NOT (NEW.media_consent <=> OLD.media_consent) OR NOT (NEW.media_consent_version <=> OLD.media_consent_version) OR NOT (NEW.media_consent_at <=> OLD.media_consent_at)
    OR NOT (NEW.submitted_at <=> OLD.submitted_at)
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: a submitted entry cannot be edited';
  END IF;
  IF OLD.status = 'draft' AND (NEW.child_age <> OLD.child_age OR NEW.event_id <> OLD.event_id) THEN
    IF NEW.child_age < (SELECT min_age FROM events WHERE id = NEW.event_id) OR NEW.child_age > (SELECT max_age FROM events WHERE id = NEW.event_id) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: the child age is outside the competition range';
    END IF;
  END IF;
  IF OLD.status = 'draft' AND NEW.question_set_id <> OLD.question_set_id THEN
    IF (SELECT status FROM question_sets WHERE id = NEW.question_set_id) <> 'published' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: an entry must use the published question set';
    END IF;
  END IF;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS submissions_guard_delete
--> statement-breakpoint
CREATE TRIGGER submissions_guard_delete BEFORE DELETE ON submissions FOR EACH ROW
BEGIN
  IF OLD.status IN ('held', 'finalized') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: a submitted entry cannot be deleted; withdraw it first';
  END IF;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS registration_recovery_guard_insert
--> statement-breakpoint
CREATE TRIGGER registration_recovery_guard_insert BEFORE INSERT ON registration_recovery FOR EACH ROW
BEGIN
  IF (SELECT status FROM submissions WHERE id = NEW.submission_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: only an unfinished entry can be recovered';
  END IF;
END
