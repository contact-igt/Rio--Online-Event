-- One answer per question per entry. Two composite foreign keys make the database itself refuse an answer to a question from another
-- set (or another competition): the entry and the question must name the same question set, and the stored type must be the question's type.
-- Answers can change only while the entry is a draft; the snapshot (prompts and chosen labels as shown) is written before it is submitted.
CREATE TABLE IF NOT EXISTS entry_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  question_set_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  question_type TEXT NOT NULL,
  value_text TEXT,
  value_number REAL,
  value_json TEXT,
  snapshot_json TEXT,
  answered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT entry_answers_one_per_question_uq UNIQUE (submission_id, question_id),
  CONSTRAINT entry_answers_submission_fk FOREIGN KEY (submission_id, question_set_id) REFERENCES submissions (id, question_set_id),
  CONSTRAINT entry_answers_question_fk FOREIGN KEY (question_set_id, question_id, question_type) REFERENCES questions (question_set_id, id, type),
  CONSTRAINT entry_answers_value_ck CHECK (
    (question_type IN ('short_text', 'paragraph', 'dropdown', 'radio') AND value_text IS NOT NULL AND length(value_text) <= 4000 AND value_number IS NULL AND value_json IS NULL)
    OR (question_type = 'number' AND value_number IS NOT NULL AND value_text IS NULL AND value_json IS NULL)
    OR (question_type = 'checkboxes' AND value_json IS NOT NULL AND json_valid(value_json) AND json_type(value_json) = 'array' AND value_text IS NULL AND value_number IS NULL)
  ),
  CONSTRAINT entry_answers_snapshot_ck CHECK (snapshot_json IS NULL OR (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'))
) STRICT
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS entry_answers_question_idx ON entry_answers (question_id)
--> statement-breakpoint
DROP TRIGGER IF EXISTS entry_answers_guard_insert
--> statement-breakpoint
CREATE TRIGGER entry_answers_guard_insert BEFORE INSERT ON entry_answers FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: answers can only be added to a draft entry') WHERE (SELECT status FROM submissions WHERE id = NEW.submission_id) <> 'draft';
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS entry_answers_guard_update
--> statement-breakpoint
CREATE TRIGGER entry_answers_guard_update BEFORE UPDATE ON entry_answers FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: answers of a submitted entry cannot be changed')
  WHERE (SELECT status FROM submissions WHERE id = OLD.submission_id) <> 'draft' OR NEW.submission_id <> OLD.submission_id OR NEW.question_id <> OLD.question_id;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS entry_answers_guard_delete
--> statement-breakpoint
CREATE TRIGGER entry_answers_guard_delete BEFORE DELETE ON entry_answers FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: answers of a submitted entry cannot be deleted') WHERE (SELECT status FROM submissions WHERE id = OLD.submission_id) <> 'draft';
END
