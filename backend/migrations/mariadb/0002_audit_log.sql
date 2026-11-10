-- MariaDB 10.4 variant of the MySQL 8 migration of the same name, for LOCAL DEVELOPMENT on XAMPP only (production is MySQL 8).
-- Same tables, keys, checks, triggers and views. The only change is the two collation names MariaDB does not have:
--   utf8mb4_0900_bin   -> utf8mb4_nopad_bin    (exact code-point comparison with no trailing-space padding: the same comparison)
--   utf8mb4_0900_ai_ci -> utf8mb4_unicode_ci    (display text only; never part of a key or a rule)
-- NOT YET RUN on a real MariaDB server: see backend/LOCAL_DEVELOPMENT.md and backend/migrations/README.md.
-- Append-only record of administrative and security-relevant actions. `details` holds ids and states only, never personal data.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT NOT NULL AUTO_INCREMENT,
  occurred_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  actor_type VARCHAR(10) COLLATE utf8mb4_nopad_bin NOT NULL,
  actor_staff_id BIGINT NULL,
  action VARCHAR(60) COLLATE utf8mb4_nopad_bin NOT NULL,
  entity_type VARCHAR(40) COLLATE utf8mb4_nopad_bin NOT NULL,
  entity_id VARCHAR(64) COLLATE utf8mb4_nopad_bin NULL,
  request_id VARCHAR(64) COLLATE utf8mb4_nopad_bin NULL,
  details JSON NULL,
  PRIMARY KEY (id),
  KEY audit_log_time_idx (occurred_at),
  KEY audit_log_entity_idx (entity_type, entity_id),
  KEY audit_log_actor_idx (actor_staff_id, occurred_at),
  CONSTRAINT audit_log_actor_fk FOREIGN KEY (actor_staff_id) REFERENCES staff_users (id),
  CONSTRAINT audit_log_actor_ck CHECK (actor_type IN ('staff', 'system', 'public') AND ((actor_type = 'staff') = (actor_staff_id IS NOT NULL))),
  CONSTRAINT audit_log_action_ck CHECK (action REGEXP '^[a-z][a-z0-9_.]{2,59}$'),
  CONSTRAINT audit_log_entity_ck CHECK (entity_type REGEXP '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT audit_log_details_ck CHECK (details IS NULL OR JSON_TYPE(details) = 'OBJECT')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_no_update
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: audit_log is append-only';
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_no_delete
--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: audit_log is append-only';
END
