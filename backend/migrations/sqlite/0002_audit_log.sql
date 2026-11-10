-- Append-only record of administrative and security-relevant actions. `details` holds ids and states only, never personal data.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor_type TEXT NOT NULL,
  actor_staff_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  request_id TEXT,
  details TEXT,
  CONSTRAINT audit_log_actor_fk FOREIGN KEY (actor_staff_id) REFERENCES staff_users (id),
  CONSTRAINT audit_log_actor_ck CHECK (actor_type IN ('staff', 'system', 'public') AND ((actor_type = 'staff') = (actor_staff_id IS NOT NULL))),
  CONSTRAINT audit_log_action_ck CHECK (length(action) BETWEEN 3 AND 60 AND action GLOB '[a-z]*' AND action NOT GLOB '*[^a-z0-9_.]*'),
  CONSTRAINT audit_log_entity_ck CHECK (length(entity_type) BETWEEN 2 AND 40 AND entity_type GLOB '[a-z]*' AND entity_type NOT GLOB '*[^a-z0-9_]*'),
  CONSTRAINT audit_log_ids_ck CHECK ((entity_id IS NULL OR length(entity_id) <= 64) AND (request_id IS NULL OR length(request_id) <= 64)),
  CONSTRAINT audit_log_details_ck CHECK (details IS NULL OR (json_valid(details) AND json_type(details) = 'object'))
) STRICT
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_log_time_idx ON audit_log (occurred_at)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity_type, entity_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor_staff_id, occurred_at)
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_no_update
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: audit_log is append-only');
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_no_delete
--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: audit_log is append-only');
END
