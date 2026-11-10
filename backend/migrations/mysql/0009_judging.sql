-- Judging. A judge sees an entry only through an assignment, scores it through a composite foreign key that names that assignment, and
-- never receives the guardian or child columns (that is an application rule for M5; the table design keeps those columns out of every judging table).
-- Marks are stored as whole hundredths (0 to 10000 = 0.00 to 100.00): exact in both engines. The 0-100 scale is a placeholder until the
-- judging rubric is decided.
CREATE TABLE IF NOT EXISTS judge_profiles (
  user_id BIGINT NOT NULL,
  role VARCHAR(10) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'judge',
  judge_code VARCHAR(20) COLLATE utf8mb4_0900_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (user_id),
  UNIQUE KEY judge_profiles_code_uq (judge_code),
  CONSTRAINT judge_profiles_staff_fk FOREIGN KEY (user_id, role) REFERENCES staff_users (id, role),
  CONSTRAINT judge_profiles_role_ck CHECK (role = 'judge'),
  CONSTRAINT judge_profiles_code_ck CHECK (judge_code REGEXP '^[A-Z0-9-]{3,20}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS judge_assignments (
  id BIGINT NOT NULL AUTO_INCREMENT,
  judge_id BIGINT NOT NULL,
  submission_id BIGINT NOT NULL,
  event_id SMALLINT NOT NULL,
  assigned_by BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY judge_assignments_pair_uq (judge_id, submission_id),
  KEY judge_assignments_submission_idx (submission_id),
  CONSTRAINT judge_assignments_judge_fk FOREIGN KEY (judge_id) REFERENCES judge_profiles (user_id),
  CONSTRAINT judge_assignments_submission_fk FOREIGN KEY (submission_id, event_id) REFERENCES submissions (id, event_id),
  CONSTRAINT judge_assignments_by_fk FOREIGN KEY (assigned_by) REFERENCES staff_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS scores (
  id BIGINT NOT NULL AUTO_INCREMENT,
  judge_id BIGINT NOT NULL,
  submission_id BIGINT NOT NULL,
  marks_hundredths INT NULL,
  comments VARCHAR(2000) NULL,
  status VARCHAR(10) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'draft',
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  finalized_at DATETIME(3) NULL,
  unlocked_by BIGINT NULL,
  unlocked_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY scores_one_per_judge_uq (judge_id, submission_id),
  KEY scores_submission_idx (submission_id),
  CONSTRAINT scores_assignment_fk FOREIGN KEY (judge_id, submission_id) REFERENCES judge_assignments (judge_id, submission_id),
  CONSTRAINT scores_unlocked_fk FOREIGN KEY (unlocked_by) REFERENCES staff_users (id),
  CONSTRAINT scores_marks_ck CHECK (marks_hundredths IS NULL OR marks_hundredths BETWEEN 0 AND 10000),
  CONSTRAINT scores_status_ck CHECK (status IN ('draft', 'final')),
  CONSTRAINT scores_final_marks_ck CHECK (status <> 'final' OR marks_hundredths IS NOT NULL),
  CONSTRAINT scores_final_stamp_ck CHECK ((status = 'final') = (finalized_at IS NOT NULL)),
  CONSTRAINT scores_unlock_ck CHECK ((unlocked_by IS NULL) = (unlocked_at IS NULL)),
  CONSTRAINT scores_comments_ck CHECK (comments IS NULL OR CHAR_LENGTH(comments) <= 2000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS winners (
  id BIGINT NOT NULL AUTO_INCREMENT,
  event_id SMALLINT NOT NULL,
  submission_id BIGINT NOT NULL,
  place TINYINT UNSIGNED NOT NULL,
  award_label VARCHAR(80) NULL,
  display_name VARCHAR(60) NOT NULL,
  approved_by BIGINT NOT NULL,
  approved_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY winners_submission_uq (submission_id),
  UNIQUE KEY winners_place_uq (event_id, place),
  CONSTRAINT winners_submission_fk FOREIGN KEY (submission_id, event_id) REFERENCES submissions (id, event_id),
  CONSTRAINT winners_approver_fk FOREIGN KEY (approved_by) REFERENCES staff_users (id),
  CONSTRAINT winners_place_ck CHECK (place BETWEEN 1 AND 10),
  CONSTRAINT winners_name_ck CHECK (CHAR_LENGTH(TRIM(display_name)) BETWEEN 1 AND 60)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
--> statement-breakpoint
DROP TRIGGER IF EXISTS judge_assignments_guard_insert
--> statement-breakpoint
CREATE TRIGGER judge_assignments_guard_insert BEFORE INSERT ON judge_assignments FOR EACH ROW
BEGIN
  IF (SELECT status FROM submissions WHERE id = NEW.submission_id) <> 'finalized' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: only a finalized entry can be assigned to a judge';
  END IF;
  IF (SELECT active FROM staff_users WHERE id = NEW.judge_id) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: an inactive judge cannot be assigned';
  END IF;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS scores_guard_insert
--> statement-breakpoint
CREATE TRIGGER scores_guard_insert BEFORE INSERT ON scores FOR EACH ROW
BEGIN
  IF (SELECT active FROM staff_users WHERE id = NEW.judge_id) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: an inactive judge cannot score';
  END IF;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS scores_guard_update
--> statement-breakpoint
CREATE TRIGGER scores_guard_update BEFORE UPDATE ON scores FOR EACH ROW
BEGIN
  IF NEW.judge_id <> OLD.judge_id OR NEW.submission_id <> OLD.submission_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: a score cannot be moved';
  END IF;
  IF OLD.status = 'final' AND NOT (NEW.status = 'draft' AND NEW.unlocked_by IS NOT NULL AND NEW.unlocked_at IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: a final score is locked; an administrator must unlock it';
  END IF;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS scores_guard_delete
--> statement-breakpoint
CREATE TRIGGER scores_guard_delete BEFORE DELETE ON scores FOR EACH ROW
BEGIN
  IF OLD.status = 'final' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: a final score cannot be deleted';
  END IF;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS winners_guard_insert
--> statement-breakpoint
CREATE TRIGGER winners_guard_insert BEFORE INSERT ON winners FOR EACH ROW
BEGIN
  IF (SELECT status FROM submissions WHERE id = NEW.submission_id) <> 'finalized' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: only a finalized entry can win';
  END IF;
  IF EXISTS (SELECT 1 FROM event_settings WHERE id = 1 AND results_publish_at IS NOT NULL AND results_publish_at <= UTC_TIMESTAMP(3)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: results are published; winners are frozen';
  END IF;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS winners_guard_update
--> statement-breakpoint
CREATE TRIGGER winners_guard_update BEFORE UPDATE ON winners FOR EACH ROW
BEGIN
  IF EXISTS (SELECT 1 FROM event_settings WHERE id = 1 AND results_publish_at IS NOT NULL AND results_publish_at <= UTC_TIMESTAMP(3)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: results are published; winners are frozen';
  END IF;
  IF NEW.submission_id <> OLD.submission_id OR NEW.event_id <> OLD.event_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: a winner cannot be moved to another entry';
  END IF;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS winners_guard_delete
--> statement-breakpoint
CREATE TRIGGER winners_guard_delete BEFORE DELETE ON winners FOR EACH ROW
BEGIN
  IF EXISTS (SELECT 1 FROM event_settings WHERE id = 1 AND results_publish_at IS NOT NULL AND results_publish_at <= UTC_TIMESTAMP(3)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: results are published; winners are frozen';
  END IF;
END
--> statement-breakpoint
CREATE OR REPLACE VIEW published_winners AS
SELECT w.id AS id, e.slug AS event_slug, w.event_id AS event_id, w.place AS place, w.award_label AS award_label, w.display_name AS display_name
FROM winners w
JOIN events e ON e.id = w.event_id
JOIN event_settings s ON s.id = 1
WHERE s.results_publish_at IS NOT NULL AND s.results_publish_at <= UTC_TIMESTAMP(3)
