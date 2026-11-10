-- MariaDB 10.4 variant of the MySQL 8 migration of the same name, for LOCAL DEVELOPMENT on XAMPP only (production is MySQL 8).
-- Same tables, keys, checks, triggers and views. The only change is the two collation names MariaDB does not have:
--   utf8mb4_0900_bin   -> utf8mb4_nopad_bin    (exact code-point comparison with no trailing-space padding: the same comparison)
--   utf8mb4_0900_ai_ci -> utf8mb4_unicode_ci    (display text only; never part of a key or a rule)
-- NOT YET RUN on a real MariaDB server: see backend/LOCAL_DEVELOPMENT.md and backend/migrations/README.md.
-- Duplicate detection outcome and the administrator's decision. `held` blocks the entry until an administrator decides; `flagged` lets it
-- through but marks it for a look; `approved` and `rejected` record the decision (who, when, why) and link to the audit_log row.
-- Both entries must belong to the same competition (composite foreign keys), and only one review per entry can be open at a time.
CREATE TABLE IF NOT EXISTS duplicate_reviews (
  id BIGINT NOT NULL AUTO_INCREMENT,
  event_id SMALLINT NOT NULL,
  submission_id BIGINT NOT NULL,
  matched_submission_id BIGINT NULL,
  status VARCHAR(10) COLLATE utf8mb4_nopad_bin NOT NULL DEFAULT 'held',
  reason VARCHAR(30) COLLATE utf8mb4_nopad_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  decided_by BIGINT NULL,
  decided_at DATETIME(3) NULL,
  decision_note VARCHAR(500) NULL,
  audit_log_id BIGINT NULL,
  open_flag TINYINT GENERATED ALWAYS AS (IF(status IN ('held', 'flagged'), 1, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY duplicate_reviews_one_open_uq (submission_id, open_flag),
  KEY duplicate_reviews_status_idx (status, created_at),
  KEY duplicate_reviews_matched_idx (matched_submission_id),
  CONSTRAINT duplicate_reviews_submission_fk FOREIGN KEY (submission_id, event_id) REFERENCES submissions (id, event_id),
  CONSTRAINT duplicate_reviews_matched_fk FOREIGN KEY (matched_submission_id, event_id) REFERENCES submissions (id, event_id),
  CONSTRAINT duplicate_reviews_decider_fk FOREIGN KEY (decided_by) REFERENCES staff_users (id),
  CONSTRAINT duplicate_reviews_audit_fk FOREIGN KEY (audit_log_id) REFERENCES audit_log (id),
  CONSTRAINT duplicate_reviews_status_ck CHECK (status IN ('held', 'flagged', 'approved', 'rejected')),
  CONSTRAINT duplicate_reviews_reason_ck CHECK (reason IN ('same_child_mobile_event', 'similar_name', 'manual')),
  CONSTRAINT duplicate_reviews_distinct_ck CHECK (matched_submission_id IS NULL OR matched_submission_id <> submission_id),
  CONSTRAINT duplicate_reviews_decision_ck CHECK (
    (status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL)
    AND (decided_by IS NULL) = (decided_at IS NULL)
  ),
  CONSTRAINT duplicate_reviews_note_ck CHECK (decision_note IS NULL OR CHAR_LENGTH(decision_note) <= 500)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
--> statement-breakpoint
DROP TRIGGER IF EXISTS duplicate_reviews_guard_update
--> statement-breakpoint
CREATE TRIGGER duplicate_reviews_guard_update BEFORE UPDATE ON duplicate_reviews FOR EACH ROW
BEGIN
  IF OLD.status IN ('approved', 'rejected') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: a decided review cannot be changed';
  END IF;
  IF NEW.submission_id <> OLD.submission_id OR NOT (NEW.matched_submission_id <=> OLD.matched_submission_id) OR NEW.event_id <> OLD.event_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: a review cannot be moved to other entries';
  END IF;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS duplicate_reviews_guard_delete
--> statement-breakpoint
CREATE TRIGGER duplicate_reviews_guard_delete BEFORE DELETE ON duplicate_reviews FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: reviews are kept as part of the audit trail';
END
