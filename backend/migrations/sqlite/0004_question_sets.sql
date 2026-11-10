-- Versioned, competition-specific questions. A set is edited while `draft`; once `published` it and its questions are immutable
-- (triggers below), so every answer refers to exactly the wording the parent saw. A new wording is a new set with the next version.
-- At most one published set per competition (generated flag + unique index).
CREATE TABLE IF NOT EXISTS question_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  published_by INTEGER,
  published_at TEXT,
  retired_at TEXT,
  published_flag INTEGER GENERATED ALWAYS AS (CASE WHEN status = 'published' THEN 1 END) STORED,
  CONSTRAINT question_sets_event_version_uq UNIQUE (event_id, version),
  CONSTRAINT question_sets_id_event_uq UNIQUE (id, event_id),
  CONSTRAINT question_sets_one_published_uq UNIQUE (event_id, published_flag),
  CONSTRAINT question_sets_event_fk FOREIGN KEY (event_id) REFERENCES events (id),
  CONSTRAINT question_sets_created_fk FOREIGN KEY (created_by) REFERENCES staff_users (id),
  CONSTRAINT question_sets_published_fk FOREIGN KEY (published_by) REFERENCES staff_users (id),
  CONSTRAINT question_sets_version_ck CHECK (version >= 1),
  CONSTRAINT question_sets_status_ck CHECK (status IN ('draft', 'published', 'retired')),
  CONSTRAINT question_sets_published_at_ck CHECK ((status = 'draft') = (published_at IS NULL)),
  CONSTRAINT question_sets_retired_at_ck CHECK ((status = 'retired') = (retired_at IS NOT NULL))
) STRICT
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_set_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  question_key TEXT NOT NULL,
  type TEXT NOT NULL,
  prompt_ta TEXT NOT NULL,
  prompt_en TEXT NOT NULL,
  help_ta TEXT,
  help_en TEXT,
  required INTEGER NOT NULL DEFAULT 0,
  options_json TEXT,
  max_length INTEGER,
  min_number REAL,
  max_number REAL,
  CONSTRAINT questions_position_uq UNIQUE (question_set_id, position),
  CONSTRAINT questions_key_uq UNIQUE (question_set_id, question_key),
  CONSTRAINT questions_set_id_type_uq UNIQUE (question_set_id, id, type),
  CONSTRAINT questions_set_fk FOREIGN KEY (question_set_id) REFERENCES question_sets (id),
  CONSTRAINT questions_position_ck CHECK (position BETWEEN 0 AND 65535),
  CONSTRAINT questions_type_ck CHECK (type IN ('short_text', 'paragraph', 'dropdown', 'radio', 'checkboxes', 'number', 'instruction')),
  CONSTRAINT questions_key_ck CHECK (length(question_key) BETWEEN 1 AND 40 AND question_key GLOB '[a-z]*' AND question_key NOT GLOB '*[^a-z0-9_]*'),
  CONSTRAINT questions_prompt_ck CHECK (
    length(trim(prompt_ta)) >= 1 AND length(trim(prompt_en)) >= 1 AND length(prompt_ta) <= 500 AND length(prompt_en) <= 500
    AND (help_ta IS NULL OR length(help_ta) <= 1000) AND (help_en IS NULL OR length(help_en) <= 1000)
  ),
  CONSTRAINT questions_required_ck CHECK (required IN (0, 1) AND (type <> 'instruction' OR required = 0)),
  CONSTRAINT questions_options_ck CHECK (
    (type IN ('dropdown', 'radio', 'checkboxes')) = (options_json IS NOT NULL)
    AND (options_json IS NULL OR (json_valid(options_json) AND json_type(options_json) = 'array' AND json_array_length(options_json) >= 1))
  ),
  CONSTRAINT questions_length_ck CHECK (max_length IS NULL OR (type IN ('short_text', 'paragraph') AND max_length BETWEEN 1 AND 65535)),
  CONSTRAINT questions_number_ck CHECK (
    (min_number IS NULL AND max_number IS NULL) OR (type = 'number' AND (min_number IS NULL OR max_number IS NULL OR min_number <= max_number))
  )
) STRICT
--> statement-breakpoint
DROP TRIGGER IF EXISTS question_sets_guard_update
--> statement-breakpoint
CREATE TRIGGER question_sets_guard_update BEFORE UPDATE ON question_sets FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: a published question set cannot be changed')
  WHERE OLD.status <> 'draft' AND (NEW.event_id <> OLD.event_id OR NEW.version <> OLD.version OR NEW.published_at IS NOT OLD.published_at OR NEW.published_by IS NOT OLD.published_by OR NEW.created_by IS NOT OLD.created_by);
  SELECT RAISE(ABORT, 'rule: a published question set can only be retired')
  WHERE OLD.status = 'published' AND NEW.status NOT IN ('published', 'retired');
  SELECT RAISE(ABORT, 'rule: a retired question set stays retired')
  WHERE OLD.status = 'retired' AND NEW.status <> 'retired';
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS question_sets_guard_delete
--> statement-breakpoint
CREATE TRIGGER question_sets_guard_delete BEFORE DELETE ON question_sets FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: a published question set cannot be deleted') WHERE OLD.status <> 'draft';
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS questions_guard_insert
--> statement-breakpoint
CREATE TRIGGER questions_guard_insert BEFORE INSERT ON questions FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: questions can only be added to a draft set') WHERE (SELECT status FROM question_sets WHERE id = NEW.question_set_id) <> 'draft';
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS questions_guard_update
--> statement-breakpoint
CREATE TRIGGER questions_guard_update BEFORE UPDATE ON questions FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: questions of a published set cannot be changed')
  WHERE (SELECT status FROM question_sets WHERE id = OLD.question_set_id) <> 'draft' OR NEW.question_set_id <> OLD.question_set_id;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS questions_guard_delete
--> statement-breakpoint
CREATE TRIGGER questions_guard_delete BEFORE DELETE ON questions FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: questions of a published set cannot be deleted') WHERE (SELECT status FROM question_sets WHERE id = OLD.question_set_id) <> 'draft';
END
