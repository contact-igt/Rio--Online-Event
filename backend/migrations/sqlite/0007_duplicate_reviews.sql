-- Duplicate detection outcome and the administrator's decision. `held` blocks the entry until an administrator decides; `flagged` lets it
-- through but marks it for a look; `approved` and `rejected` record the decision (who, when, why) and link to the audit_log row.
-- Both entries must belong to the same competition (composite foreign keys), and only one review per entry can be open at a time.
CREATE TABLE IF NOT EXISTS duplicate_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  submission_id INTEGER NOT NULL,
  matched_submission_id INTEGER,
  status TEXT NOT NULL DEFAULT 'held',
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_by INTEGER,
  decided_at TEXT,
  decision_note TEXT,
  audit_log_id INTEGER,
  open_flag INTEGER GENERATED ALWAYS AS (CASE WHEN status IN ('held', 'flagged') THEN 1 END) STORED,
  CONSTRAINT duplicate_reviews_one_open_uq UNIQUE (submission_id, open_flag),
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
  CONSTRAINT duplicate_reviews_note_ck CHECK (decision_note IS NULL OR length(decision_note) <= 500)
) STRICT
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS duplicate_reviews_status_idx ON duplicate_reviews (status, created_at)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS duplicate_reviews_matched_idx ON duplicate_reviews (matched_submission_id)
--> statement-breakpoint
DROP TRIGGER IF EXISTS duplicate_reviews_guard_update
--> statement-breakpoint
CREATE TRIGGER duplicate_reviews_guard_update BEFORE UPDATE ON duplicate_reviews FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: a decided review cannot be changed') WHERE OLD.status IN ('approved', 'rejected');
  SELECT RAISE(ABORT, 'rule: a review cannot be moved to other entries')
  WHERE NEW.submission_id <> OLD.submission_id OR NEW.matched_submission_id IS NOT OLD.matched_submission_id OR NEW.event_id <> OLD.event_id;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS duplicate_reviews_guard_delete
--> statement-breakpoint
CREATE TRIGGER duplicate_reviews_guard_delete BEFORE DELETE ON duplicate_reviews FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: reviews are kept as part of the audit trail');
END
