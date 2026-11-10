-- MariaDB 10.4 variant of the MySQL 8 migration of the same name, for LOCAL DEVELOPMENT on XAMPP only (production is MySQL 8).
-- Same tables, keys, checks, triggers and views. The only change is the two collation names MariaDB does not have:
--   utf8mb4_0900_bin   -> utf8mb4_nopad_bin    (exact code-point comparison with no trailing-space padding: the same comparison)
--   utf8mb4_0900_ai_ci -> utf8mb4_unicode_ci    (display text only; never part of a key or a rule)
-- NOT YET RUN on a real MariaDB server: see backend/LOCAL_DEVELOPMENT.md and backend/migrations/README.md.
-- Versioned, competition-specific questions. A set is edited while `draft`; once `published` it and its questions are immutable
-- (triggers below), so every answer refers to exactly the wording the parent saw. A new wording is a new set with the next version.
-- At most one published set per competition (generated flag + unique key).
CREATE TABLE IF NOT EXISTS question_sets (
  id BIGINT NOT NULL AUTO_INCREMENT,
  event_id SMALLINT NOT NULL,
  version INT UNSIGNED NOT NULL,
  status VARCHAR(10) COLLATE utf8mb4_nopad_bin NOT NULL DEFAULT 'draft',
  created_by BIGINT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  published_by BIGINT NULL,
  published_at DATETIME(3) NULL,
  retired_at DATETIME(3) NULL,
  published_flag TINYINT GENERATED ALWAYS AS (IF(status = 'published', 1, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY question_sets_event_version_uq (event_id, version),
  UNIQUE KEY question_sets_id_event_uq (id, event_id),
  UNIQUE KEY question_sets_one_published_uq (event_id, published_flag),
  CONSTRAINT question_sets_event_fk FOREIGN KEY (event_id) REFERENCES events (id),
  CONSTRAINT question_sets_created_fk FOREIGN KEY (created_by) REFERENCES staff_users (id),
  CONSTRAINT question_sets_published_fk FOREIGN KEY (published_by) REFERENCES staff_users (id),
  CONSTRAINT question_sets_version_ck CHECK (version >= 1),
  CONSTRAINT question_sets_status_ck CHECK (status IN ('draft', 'published', 'retired')),
  CONSTRAINT question_sets_published_at_ck CHECK ((status = 'draft') = (published_at IS NULL)),
  CONSTRAINT question_sets_retired_at_ck CHECK ((status = 'retired') = (retired_at IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS questions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  question_set_id BIGINT NOT NULL,
  position SMALLINT UNSIGNED NOT NULL,
  question_key VARCHAR(40) COLLATE utf8mb4_nopad_bin NOT NULL,
  type VARCHAR(12) COLLATE utf8mb4_nopad_bin NOT NULL,
  prompt_ta VARCHAR(500) NOT NULL,
  prompt_en VARCHAR(500) NOT NULL,
  help_ta VARCHAR(1000) NULL,
  help_en VARCHAR(1000) NULL,
  required TINYINT(1) NOT NULL DEFAULT 0,
  options_json JSON NULL,
  max_length SMALLINT UNSIGNED NULL,
  min_number DOUBLE NULL,
  max_number DOUBLE NULL,
  PRIMARY KEY (id),
  UNIQUE KEY questions_position_uq (question_set_id, position),
  UNIQUE KEY questions_key_uq (question_set_id, question_key),
  UNIQUE KEY questions_set_id_type_uq (question_set_id, id, type),
  CONSTRAINT questions_set_fk FOREIGN KEY (question_set_id) REFERENCES question_sets (id),
  CONSTRAINT questions_type_ck CHECK (type IN ('short_text', 'paragraph', 'dropdown', 'radio', 'checkboxes', 'number', 'instruction')),
  CONSTRAINT questions_key_ck CHECK (question_key REGEXP '^[a-z][a-z0-9_]{0,39}$'),
  CONSTRAINT questions_prompt_ck CHECK (CHAR_LENGTH(TRIM(prompt_ta)) >= 1 AND CHAR_LENGTH(TRIM(prompt_en)) >= 1),
  CONSTRAINT questions_required_ck CHECK (required IN (0, 1) AND (type <> 'instruction' OR required = 0)),
  CONSTRAINT questions_options_ck CHECK (
    (type IN ('dropdown', 'radio', 'checkboxes')) = (options_json IS NOT NULL)
    AND (options_json IS NULL OR (JSON_TYPE(options_json) = 'ARRAY' AND JSON_LENGTH(options_json) >= 1))
  ),
  CONSTRAINT questions_length_ck CHECK (max_length IS NULL OR (type IN ('short_text', 'paragraph') AND max_length >= 1)),
  CONSTRAINT questions_number_ck CHECK (
    (min_number IS NULL AND max_number IS NULL) OR (type = 'number' AND (min_number IS NULL OR max_number IS NULL OR min_number <= max_number))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
--> statement-breakpoint
DROP TRIGGER IF EXISTS question_sets_guard_update
--> statement-breakpoint
CREATE TRIGGER question_sets_guard_update BEFORE UPDATE ON question_sets FOR EACH ROW
BEGIN
  IF OLD.status <> 'draft' AND (NEW.event_id <> OLD.event_id OR NEW.version <> OLD.version OR NOT (NEW.published_at <=> OLD.published_at) OR NOT (NEW.published_by <=> OLD.published_by) OR NOT (NEW.created_by <=> OLD.created_by)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: a published question set cannot be changed';
  END IF;
  IF OLD.status = 'published' AND NEW.status NOT IN ('published', 'retired') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: a published question set can only be retired';
  END IF;
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: a retired question set stays retired';
  END IF;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS question_sets_guard_delete
--> statement-breakpoint
CREATE TRIGGER question_sets_guard_delete BEFORE DELETE ON question_sets FOR EACH ROW
BEGIN
  IF OLD.status <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: a published question set cannot be deleted';
  END IF;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS questions_guard_insert
--> statement-breakpoint
CREATE TRIGGER questions_guard_insert BEFORE INSERT ON questions FOR EACH ROW
BEGIN
  IF (SELECT status FROM question_sets WHERE id = NEW.question_set_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: questions can only be added to a draft set';
  END IF;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS questions_guard_update
--> statement-breakpoint
CREATE TRIGGER questions_guard_update BEFORE UPDATE ON questions FOR EACH ROW
BEGIN
  IF (SELECT status FROM question_sets WHERE id = OLD.question_set_id) <> 'draft' OR NEW.question_set_id <> OLD.question_set_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: questions of a published set cannot be changed';
  END IF;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS questions_guard_delete
--> statement-breakpoint
CREATE TRIGGER questions_guard_delete BEFORE DELETE ON questions FOR EACH ROW
BEGIN
  IF (SELECT status FROM question_sets WHERE id = OLD.question_set_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: questions of a published set cannot be deleted';
  END IF;
END
