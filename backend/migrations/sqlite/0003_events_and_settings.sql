-- The competitions, and the one row of event settings that an administrator edits (registration window, consent versions, results time).
-- No event dates and no consent text are stored here: they are entered by an administrator, and the consent wording itself lives in code by version.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  name_ta TEXT NOT NULL,
  name_en TEXT NOT NULL,
  min_age INTEGER NOT NULL,
  max_age INTEGER NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT events_slug_uq UNIQUE (slug),
  CONSTRAINT events_slug_ck CHECK (
    length(slug) BETWEEN 1 AND 60 AND slug NOT GLOB '*[^a-z0-9-]*' AND slug NOT GLOB '-*' AND slug NOT GLOB '*-' AND slug NOT GLOB '*--*'
  ),
  CONSTRAINT events_age_ck CHECK (min_age >= 1 AND max_age <= 18 AND min_age <= max_age),
  CONSTRAINT events_names_ck CHECK (length(trim(name_ta)) >= 1 AND length(trim(name_en)) >= 1 AND length(name_ta) <= 200 AND length(name_en) <= 200),
  CONSTRAINT events_active_ck CHECK (active IN (0, 1))
) STRICT
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS event_settings (
  id INTEGER PRIMARY KEY,
  submissions_open_at TEXT,
  submissions_close_at TEXT,
  results_publish_at TEXT,
  guardian_consent_version TEXT,
  media_consent_version TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by INTEGER,
  CONSTRAINT event_settings_fk FOREIGN KEY (updated_by) REFERENCES staff_users (id),
  CONSTRAINT event_settings_single_ck CHECK (id = 1),
  CONSTRAINT event_settings_window_ck CHECK (submissions_open_at IS NULL OR submissions_close_at IS NULL OR submissions_close_at > submissions_open_at),
  CONSTRAINT event_settings_open_needs_ck CHECK (submissions_open_at IS NULL OR (submissions_close_at IS NOT NULL AND guardian_consent_version IS NOT NULL)),
  CONSTRAINT event_settings_results_ck CHECK (results_publish_at IS NULL OR (submissions_close_at IS NOT NULL AND results_publish_at >= submissions_close_at)),
  CONSTRAINT event_settings_consent_ck CHECK (
    (guardian_consent_version IS NULL OR (length(guardian_consent_version) BETWEEN 1 AND 40 AND guardian_consent_version NOT GLOB '*[^A-Za-z0-9._-]*'))
    AND (media_consent_version IS NULL OR (length(media_consent_version) BETWEEN 1 AND 40 AND media_consent_version NOT GLOB '*[^A-Za-z0-9._-]*'))
  )
) STRICT
--> statement-breakpoint
INSERT OR IGNORE INTO event_settings (id) VALUES (1)
--> statement-breakpoint
DROP TRIGGER IF EXISTS event_settings_results_guard
--> statement-breakpoint
CREATE TRIGGER event_settings_results_guard BEFORE UPDATE ON event_settings FOR EACH ROW
WHEN NEW.results_publish_at IS NOT OLD.results_publish_at
BEGIN
  SELECT RAISE(ABORT, 'rule: results are already published and cannot be rescheduled')
  WHERE OLD.results_publish_at IS NOT NULL AND OLD.results_publish_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
  SELECT RAISE(ABORT, 'rule: the results time must be in the future when it is set')
  WHERE NEW.results_publish_at IS NOT NULL AND NEW.results_publish_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END
