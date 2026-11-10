-- MariaDB 10.4 variant of the MySQL 8 migration of the same name, for LOCAL DEVELOPMENT on XAMPP only (production is MySQL 8).
-- Same tables, keys, checks, triggers and views. The only change is the two collation names MariaDB does not have:
--   utf8mb4_0900_bin   -> utf8mb4_nopad_bin    (exact code-point comparison with no trailing-space padding: the same comparison)
--   utf8mb4_0900_ai_ci -> utf8mb4_unicode_ci    (display text only; never part of a key or a rule)
-- NOT YET RUN on a real MariaDB server: see backend/LOCAL_DEVELOPMENT.md and backend/migrations/README.md.
-- The competitions, and the one row of event settings that an administrator edits (registration window, consent versions, results time).
-- No event dates and no consent text are stored here: they are entered by an administrator, and the consent wording itself lives in code by version.
CREATE TABLE IF NOT EXISTS events (
  id SMALLINT NOT NULL AUTO_INCREMENT,
  slug VARCHAR(60) COLLATE utf8mb4_nopad_bin NOT NULL,
  name_ta VARCHAR(200) NOT NULL,
  name_en VARCHAR(200) NOT NULL,
  min_age TINYINT UNSIGNED NOT NULL,
  max_age TINYINT UNSIGNED NOT NULL,
  display_order SMALLINT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY events_slug_uq (slug),
  CONSTRAINT events_slug_ck CHECK (slug REGEXP '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT events_age_ck CHECK (min_age >= 1 AND max_age <= 18 AND min_age <= max_age),
  CONSTRAINT events_names_ck CHECK (CHAR_LENGTH(TRIM(name_ta)) >= 1 AND CHAR_LENGTH(TRIM(name_en)) >= 1),
  CONSTRAINT events_active_ck CHECK (active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS event_settings (
  id TINYINT NOT NULL,
  submissions_open_at DATETIME(3) NULL,
  submissions_close_at DATETIME(3) NULL,
  results_publish_at DATETIME(3) NULL,
  guardian_consent_version VARCHAR(40) COLLATE utf8mb4_nopad_bin NULL,
  media_consent_version VARCHAR(40) COLLATE utf8mb4_nopad_bin NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_by BIGINT NULL,
  PRIMARY KEY (id),
  CONSTRAINT event_settings_fk FOREIGN KEY (updated_by) REFERENCES staff_users (id),
  CONSTRAINT event_settings_single_ck CHECK (id = 1),
  CONSTRAINT event_settings_window_ck CHECK (submissions_open_at IS NULL OR submissions_close_at IS NULL OR submissions_close_at > submissions_open_at),
  CONSTRAINT event_settings_open_needs_ck CHECK (submissions_open_at IS NULL OR (submissions_close_at IS NOT NULL AND guardian_consent_version IS NOT NULL)),
  CONSTRAINT event_settings_results_ck CHECK (results_publish_at IS NULL OR (submissions_close_at IS NOT NULL AND results_publish_at >= submissions_close_at)),
  CONSTRAINT event_settings_consent_ck CHECK (
    (guardian_consent_version IS NULL OR guardian_consent_version REGEXP '^[A-Za-z0-9._-]{1,40}$')
    AND (media_consent_version IS NULL OR media_consent_version REGEXP '^[A-Za-z0-9._-]{1,40}$')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
--> statement-breakpoint
INSERT IGNORE INTO event_settings (id) VALUES (1)
--> statement-breakpoint
DROP TRIGGER IF EXISTS event_settings_results_guard
--> statement-breakpoint
CREATE TRIGGER event_settings_results_guard BEFORE UPDATE ON event_settings FOR EACH ROW
BEGIN
  IF NOT (NEW.results_publish_at <=> OLD.results_publish_at) THEN
    IF OLD.results_publish_at IS NOT NULL AND OLD.results_publish_at <= UTC_TIMESTAMP(3) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: results are already published and cannot be rescheduled';
    END IF;
    IF NEW.results_publish_at IS NOT NULL AND NEW.results_publish_at <= UTC_TIMESTAMP(3) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: the results time must be in the future when it is set';
    END IF;
  END IF;
END
