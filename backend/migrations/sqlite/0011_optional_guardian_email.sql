-- rio:foreign-keys-off
-- The guardian's e-mail address is optional (M4): there are no parent accounts, and the recovery code is shown on screen, so an address is only
-- a convenience. SQLite cannot drop NOT NULL from a column, so the table is rebuilt (the procedure from the SQLite documentation, "Making Other
-- Kinds Of Table Schema Changes"). Everything else about the table, its constraints, indexes and triggers, is unchanged except that the
-- trigger which freezes a submitted entry now compares the address null-safely (IS NOT instead of <>).
--
-- The marker on the first line makes the runner switch foreign-key enforcement off around this one migration (it can only be switched outside
-- a transaction), check PRAGMA foreign_key_check before COMMIT, and switch enforcement back on. legacy_alter_table keeps RENAME from
-- re-validating triggers of other tables that mention submissions while the table does not exist; it is put back below.
PRAGMA legacy_alter_table = ON
--> statement-breakpoint
CREATE TABLE submissions_rebuild (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_code TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  question_set_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  child_name TEXT NOT NULL,
  child_name_norm TEXT NOT NULL,
  child_age INTEGER NOT NULL,
  guardian_name TEXT NOT NULL,
  guardian_mobile TEXT NOT NULL,
  guardian_email TEXT,
  guardian_consent_version TEXT,
  guardian_consent_at TEXT,
  media_consent INTEGER,
  media_consent_version TEXT,
  media_consent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  submitted_at TEXT,
  finalized_at TEXT,
  withdrawn_at TEXT,
  finalized_flag INTEGER GENERATED ALWAYS AS (CASE WHEN status = 'finalized' THEN 1 END) STORED,
  CONSTRAINT submissions_entry_code_uq UNIQUE (entry_code),
  CONSTRAINT submissions_id_event_uq UNIQUE (id, event_id),
  CONSTRAINT submissions_id_set_uq UNIQUE (id, question_set_id),
  CONSTRAINT submissions_one_finalized_uq UNIQUE (event_id, child_name_norm, guardian_mobile, finalized_flag),
  CONSTRAINT submissions_event_fk FOREIGN KEY (event_id) REFERENCES events (id),
  CONSTRAINT submissions_set_fk FOREIGN KEY (question_set_id, event_id) REFERENCES question_sets (id, event_id),
  CONSTRAINT submissions_status_ck CHECK (status IN ('draft', 'held', 'finalized', 'withdrawn', 'rejected')),
  CONSTRAINT submissions_code_ck CHECK (length(entry_code) BETWEEN 6 AND 16 AND entry_code NOT GLOB '*[^A-Z0-9]*'),
  CONSTRAINT submissions_child_ck CHECK (
    length(trim(child_name)) BETWEEN 1 AND 80 AND length(child_name) <= 80 AND length(child_name_norm) BETWEEN 1 AND 160 AND child_age BETWEEN 1 AND 18
  ),
  CONSTRAINT submissions_guardian_ck CHECK (length(trim(guardian_name)) BETWEEN 1 AND 80 AND length(guardian_name) <= 80),
  CONSTRAINT submissions_mobile_ck CHECK (
    length(guardian_mobile) = 13 AND substr(guardian_mobile, 1, 3) = '+91' AND substr(guardian_mobile, 4, 1) IN ('6', '7', '8', '9') AND substr(guardian_mobile, 4) NOT GLOB '*[^0-9]*'
  ),
  CONSTRAINT submissions_email_ck CHECK (
    length(guardian_email) <= 254 AND guardian_email = lower(guardian_email) AND guardian_email LIKE '_%@_%._%' AND guardian_email NOT LIKE '% %'
    AND length(guardian_email) - length(replace(guardian_email, '@', '')) = 1
  ),
  CONSTRAINT submissions_guardian_consent_ck CHECK (
    (guardian_consent_version IS NULL) = (guardian_consent_at IS NULL)
    AND (guardian_consent_version IS NULL OR (length(guardian_consent_version) BETWEEN 1 AND 40 AND guardian_consent_version NOT GLOB '*[^A-Za-z0-9._-]*'))
    AND (status NOT IN ('held', 'finalized') OR guardian_consent_at IS NOT NULL)
  ),
  CONSTRAINT submissions_media_consent_ck CHECK (
    (media_consent IS NULL OR media_consent IN (0, 1))
    AND (media_consent IS NULL) = (media_consent_at IS NULL)
    AND (media_consent IS NULL) = (media_consent_version IS NULL)
    AND (media_consent_version IS NULL OR (length(media_consent_version) BETWEEN 1 AND 40 AND media_consent_version NOT GLOB '*[^A-Za-z0-9._-]*'))
  ),
  CONSTRAINT submissions_stamps_ck CHECK (
    (status NOT IN ('held', 'finalized') OR submitted_at IS NOT NULL)
    AND (status <> 'finalized' OR finalized_at IS NOT NULL)
    AND (finalized_at IS NULL OR status IN ('finalized', 'withdrawn'))
    AND ((status = 'withdrawn') = (withdrawn_at IS NOT NULL))
  )
) STRICT
--> statement-breakpoint
INSERT INTO submissions_rebuild (
  id, entry_code, event_id, question_set_id, status, child_name, child_name_norm, child_age, guardian_name, guardian_mobile, guardian_email,
  guardian_consent_version, guardian_consent_at, media_consent, media_consent_version, media_consent_at, created_at, updated_at, submitted_at, finalized_at, withdrawn_at
)
SELECT
  id, entry_code, event_id, question_set_id, status, child_name, child_name_norm, child_age, guardian_name, guardian_mobile, guardian_email,
  guardian_consent_version, guardian_consent_at, media_consent, media_consent_version, media_consent_at, created_at, updated_at, submitted_at, finalized_at, withdrawn_at
FROM submissions
--> statement-breakpoint
DROP TABLE submissions
--> statement-breakpoint
ALTER TABLE submissions_rebuild RENAME TO submissions
--> statement-breakpoint
PRAGMA legacy_alter_table = OFF
--> statement-breakpoint
CREATE INDEX submissions_mobile_idx ON submissions (guardian_mobile)
--> statement-breakpoint
CREATE INDEX submissions_event_status_idx ON submissions (event_id, status)
--> statement-breakpoint
DROP TRIGGER IF EXISTS submissions_guard_insert
--> statement-breakpoint
CREATE TRIGGER submissions_guard_insert BEFORE INSERT ON submissions FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: an entry starts as a draft') WHERE NEW.status <> 'draft';
  SELECT RAISE(ABORT, 'rule: the child age is outside the competition range')
  WHERE NEW.child_age < (SELECT min_age FROM events WHERE id = NEW.event_id) OR NEW.child_age > (SELECT max_age FROM events WHERE id = NEW.event_id);
  SELECT RAISE(ABORT, 'rule: an entry must use the published question set') WHERE (SELECT status FROM question_sets WHERE id = NEW.question_set_id) <> 'published';
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS submissions_guard_update
--> statement-breakpoint
CREATE TRIGGER submissions_guard_update BEFORE UPDATE ON submissions FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: this status change is not allowed')
  WHERE NEW.status <> OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('held', 'finalized', 'withdrawn'))
    OR (OLD.status = 'held' AND NEW.status IN ('finalized', 'rejected', 'withdrawn'))
    OR (OLD.status = 'finalized' AND NEW.status = 'withdrawn')
  );
  SELECT RAISE(ABORT, 'rule: a submitted entry cannot be edited')
  WHERE OLD.status <> 'draft' AND (
    NEW.entry_code <> OLD.entry_code OR NEW.event_id <> OLD.event_id OR NEW.question_set_id <> OLD.question_set_id
    OR NEW.child_name <> OLD.child_name OR NEW.child_name_norm <> OLD.child_name_norm OR NEW.child_age <> OLD.child_age
    OR NEW.guardian_name <> OLD.guardian_name OR NEW.guardian_mobile <> OLD.guardian_mobile OR NEW.guardian_email IS NOT OLD.guardian_email
    OR NEW.guardian_consent_version IS NOT OLD.guardian_consent_version OR NEW.guardian_consent_at IS NOT OLD.guardian_consent_at
    OR NEW.media_consent IS NOT OLD.media_consent OR NEW.media_consent_version IS NOT OLD.media_consent_version OR NEW.media_consent_at IS NOT OLD.media_consent_at
    OR NEW.submitted_at IS NOT OLD.submitted_at
  );
  SELECT RAISE(ABORT, 'rule: the child age is outside the competition range')
  WHERE OLD.status = 'draft' AND (NEW.child_age <> OLD.child_age OR NEW.event_id <> OLD.event_id)
    AND (NEW.child_age < (SELECT min_age FROM events WHERE id = NEW.event_id) OR NEW.child_age > (SELECT max_age FROM events WHERE id = NEW.event_id));
  SELECT RAISE(ABORT, 'rule: an entry must use the published question set')
  WHERE OLD.status = 'draft' AND NEW.question_set_id <> OLD.question_set_id AND (SELECT status FROM question_sets WHERE id = NEW.question_set_id) <> 'published';
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS submissions_guard_delete
--> statement-breakpoint
CREATE TRIGGER submissions_guard_delete BEFORE DELETE ON submissions FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: a submitted entry cannot be deleted; withdraw it first') WHERE OLD.status IN ('held', 'finalized');
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS submissions_require_video
--> statement-breakpoint
CREATE TRIGGER submissions_require_video BEFORE UPDATE ON submissions FOR EACH ROW
WHEN NEW.status IN ('held', 'finalized') AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'rule: an entry needs a verified video before it is submitted')
  WHERE NOT EXISTS (SELECT 1 FROM video_uploads WHERE submission_id = NEW.id AND status = 'verified');
END
