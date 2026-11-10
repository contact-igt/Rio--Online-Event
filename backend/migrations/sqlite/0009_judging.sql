-- Judging. A judge sees an entry only through an assignment, scores it through a composite foreign key that names that assignment, and
-- never receives the guardian or child columns (that is an application rule for M5; the table design keeps those columns out of every judging table).
-- Marks are stored as whole hundredths (0 to 10000 = 0.00 to 100.00): exact in both engines. The 0-100 scale is a placeholder until the
-- judging rubric is decided.
CREATE TABLE IF NOT EXISTS judge_profiles (
  user_id INTEGER PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'judge',
  judge_code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT judge_profiles_code_uq UNIQUE (judge_code),
  CONSTRAINT judge_profiles_staff_fk FOREIGN KEY (user_id, role) REFERENCES staff_users (id, role),
  CONSTRAINT judge_profiles_role_ck CHECK (role = 'judge'),
  CONSTRAINT judge_profiles_code_ck CHECK (length(judge_code) BETWEEN 3 AND 20 AND judge_code NOT GLOB '*[^A-Z0-9-]*')
) STRICT
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS judge_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  judge_id INTEGER NOT NULL,
  submission_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  assigned_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT judge_assignments_pair_uq UNIQUE (judge_id, submission_id),
  CONSTRAINT judge_assignments_judge_fk FOREIGN KEY (judge_id) REFERENCES judge_profiles (user_id),
  CONSTRAINT judge_assignments_submission_fk FOREIGN KEY (submission_id, event_id) REFERENCES submissions (id, event_id),
  CONSTRAINT judge_assignments_by_fk FOREIGN KEY (assigned_by) REFERENCES staff_users (id)
) STRICT
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS judge_assignments_submission_idx ON judge_assignments (submission_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  judge_id INTEGER NOT NULL,
  submission_id INTEGER NOT NULL,
  marks_hundredths INTEGER,
  comments TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finalized_at TEXT,
  unlocked_by INTEGER,
  unlocked_at TEXT,
  CONSTRAINT scores_one_per_judge_uq UNIQUE (judge_id, submission_id),
  CONSTRAINT scores_assignment_fk FOREIGN KEY (judge_id, submission_id) REFERENCES judge_assignments (judge_id, submission_id),
  CONSTRAINT scores_unlocked_fk FOREIGN KEY (unlocked_by) REFERENCES staff_users (id),
  CONSTRAINT scores_marks_ck CHECK (marks_hundredths IS NULL OR marks_hundredths BETWEEN 0 AND 10000),
  CONSTRAINT scores_status_ck CHECK (status IN ('draft', 'final')),
  CONSTRAINT scores_final_marks_ck CHECK (status <> 'final' OR marks_hundredths IS NOT NULL),
  CONSTRAINT scores_final_stamp_ck CHECK ((status = 'final') = (finalized_at IS NOT NULL)),
  CONSTRAINT scores_unlock_ck CHECK ((unlocked_by IS NULL) = (unlocked_at IS NULL)),
  CONSTRAINT scores_comments_ck CHECK (comments IS NULL OR length(comments) <= 2000)
) STRICT
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS scores_submission_idx ON scores (submission_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS winners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  submission_id INTEGER NOT NULL,
  place INTEGER NOT NULL,
  award_label TEXT,
  display_name TEXT NOT NULL,
  approved_by INTEGER NOT NULL,
  approved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT winners_submission_uq UNIQUE (submission_id),
  CONSTRAINT winners_place_uq UNIQUE (event_id, place),
  CONSTRAINT winners_submission_fk FOREIGN KEY (submission_id, event_id) REFERENCES submissions (id, event_id),
  CONSTRAINT winners_approver_fk FOREIGN KEY (approved_by) REFERENCES staff_users (id),
  CONSTRAINT winners_place_ck CHECK (place BETWEEN 1 AND 10),
  CONSTRAINT winners_name_ck CHECK (length(trim(display_name)) BETWEEN 1 AND 60 AND length(display_name) <= 60),
  CONSTRAINT winners_label_ck CHECK (award_label IS NULL OR length(award_label) <= 80)
) STRICT
--> statement-breakpoint
DROP TRIGGER IF EXISTS judge_assignments_guard_insert
--> statement-breakpoint
CREATE TRIGGER judge_assignments_guard_insert BEFORE INSERT ON judge_assignments FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: only a finalized entry can be assigned to a judge') WHERE (SELECT status FROM submissions WHERE id = NEW.submission_id) <> 'finalized';
  SELECT RAISE(ABORT, 'rule: an inactive judge cannot be assigned') WHERE (SELECT active FROM staff_users WHERE id = NEW.judge_id) <> 1;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS scores_guard_insert
--> statement-breakpoint
CREATE TRIGGER scores_guard_insert BEFORE INSERT ON scores FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: an inactive judge cannot score') WHERE (SELECT active FROM staff_users WHERE id = NEW.judge_id) <> 1;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS scores_guard_update
--> statement-breakpoint
CREATE TRIGGER scores_guard_update BEFORE UPDATE ON scores FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: a score cannot be moved') WHERE NEW.judge_id <> OLD.judge_id OR NEW.submission_id <> OLD.submission_id;
  SELECT RAISE(ABORT, 'rule: a final score is locked; an administrator must unlock it')
  WHERE OLD.status = 'final' AND NOT (NEW.status = 'draft' AND NEW.unlocked_by IS NOT NULL AND NEW.unlocked_at IS NOT NULL);
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS scores_guard_delete
--> statement-breakpoint
CREATE TRIGGER scores_guard_delete BEFORE DELETE ON scores FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: a final score cannot be deleted') WHERE OLD.status = 'final';
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS winners_guard_insert
--> statement-breakpoint
CREATE TRIGGER winners_guard_insert BEFORE INSERT ON winners FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: only a finalized entry can win') WHERE (SELECT status FROM submissions WHERE id = NEW.submission_id) <> 'finalized';
  SELECT RAISE(ABORT, 'rule: results are published; winners are frozen')
  WHERE EXISTS (SELECT 1 FROM event_settings WHERE id = 1 AND results_publish_at IS NOT NULL AND results_publish_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS winners_guard_update
--> statement-breakpoint
CREATE TRIGGER winners_guard_update BEFORE UPDATE ON winners FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: results are published; winners are frozen')
  WHERE EXISTS (SELECT 1 FROM event_settings WHERE id = 1 AND results_publish_at IS NOT NULL AND results_publish_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  SELECT RAISE(ABORT, 'rule: a winner cannot be moved to another entry') WHERE NEW.submission_id <> OLD.submission_id OR NEW.event_id <> OLD.event_id;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS winners_guard_delete
--> statement-breakpoint
CREATE TRIGGER winners_guard_delete BEFORE DELETE ON winners FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: results are published; winners are frozen')
  WHERE EXISTS (SELECT 1 FROM event_settings WHERE id = 1 AND results_publish_at IS NOT NULL AND results_publish_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END
--> statement-breakpoint
DROP VIEW IF EXISTS published_winners
--> statement-breakpoint
CREATE VIEW published_winners AS
SELECT w.id AS id, e.slug AS event_slug, w.event_id AS event_id, w.place AS place, w.award_label AS award_label, w.display_name AS display_name
FROM winners w
JOIN events e ON e.id = w.event_id
JOIN event_settings s ON s.id = 1
WHERE s.results_publish_at IS NOT NULL AND s.results_publish_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
