-- MariaDB 10.4 variant of the MySQL 8 migration of the same name, for LOCAL DEVELOPMENT on XAMPP only (production is MySQL 8).
-- Same tables, keys, checks, triggers and views. The only change is the two collation names MariaDB does not have:
--   utf8mb4_0900_bin   -> utf8mb4_nopad_bin    (exact code-point comparison with no trailing-space padding: the same comparison)
--   utf8mb4_0900_ai_ci -> utf8mb4_unicode_ci    (display text only; never part of a key or a rule)
-- NOT YET RUN on a real MariaDB server: see backend/LOCAL_DEVELOPMENT.md and backend/migrations/README.md.
-- One answer per question per entry. Two composite foreign keys make the database itself refuse an answer to a question from another
-- set (or another competition): the entry and the question must name the same question set, and the stored type must be the question's type.
-- Answers can change only while the entry is a draft; the snapshot (prompts and chosen labels as shown) is written before it is submitted.
CREATE TABLE IF NOT EXISTS entry_answers (
  id BIGINT NOT NULL AUTO_INCREMENT,
  submission_id BIGINT NOT NULL,
  question_set_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  question_type VARCHAR(12) COLLATE utf8mb4_nopad_bin NOT NULL,
  value_text VARCHAR(4000) NULL,
  value_number DOUBLE NULL,
  value_json JSON NULL,
  snapshot_json JSON NULL,
  answered_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY entry_answers_one_per_question_uq (submission_id, question_id),
  KEY entry_answers_question_idx (question_id),
  CONSTRAINT entry_answers_submission_fk FOREIGN KEY (submission_id, question_set_id) REFERENCES submissions (id, question_set_id),
  CONSTRAINT entry_answers_question_fk FOREIGN KEY (question_set_id, question_id, question_type) REFERENCES questions (question_set_id, id, type),
  CONSTRAINT entry_answers_value_ck CHECK (
    (question_type IN ('short_text', 'paragraph', 'dropdown', 'radio') AND value_text IS NOT NULL AND value_number IS NULL AND value_json IS NULL)
    OR (question_type = 'number' AND value_number IS NOT NULL AND value_text IS NULL AND value_json IS NULL)
    OR (question_type = 'checkboxes' AND value_json IS NOT NULL AND JSON_TYPE(value_json) = 'ARRAY' AND value_text IS NULL AND value_number IS NULL)
  ),
  CONSTRAINT entry_answers_snapshot_ck CHECK (snapshot_json IS NULL OR JSON_TYPE(snapshot_json) = 'OBJECT')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
--> statement-breakpoint
DROP TRIGGER IF EXISTS entry_answers_guard_insert
--> statement-breakpoint
CREATE TRIGGER entry_answers_guard_insert BEFORE INSERT ON entry_answers FOR EACH ROW
BEGIN
  IF (SELECT status FROM submissions WHERE id = NEW.submission_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: answers can only be added to a draft entry';
  END IF;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS entry_answers_guard_update
--> statement-breakpoint
CREATE TRIGGER entry_answers_guard_update BEFORE UPDATE ON entry_answers FOR EACH ROW
BEGIN
  IF (SELECT status FROM submissions WHERE id = OLD.submission_id) <> 'draft' OR NEW.submission_id <> OLD.submission_id OR NEW.question_id <> OLD.question_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: answers of a submitted entry cannot be changed';
  END IF;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS entry_answers_guard_delete
--> statement-breakpoint
CREATE TRIGGER entry_answers_guard_delete BEFORE DELETE ON entry_answers FOR EACH ROW
BEGIN
  IF (SELECT status FROM submissions WHERE id = OLD.submission_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: answers of a submitted entry cannot be deleted';
  END IF;
END
