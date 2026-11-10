-- One row per signed upload. The video itself is in the private R2 bucket under `object_key` (a random UUID, never derived from a name).
-- The size and type limits are the ones in website/lib/upload/rules.ts (100 KB to 100 MB; mp4, quicktime, webm).
-- `verified` means the stored object was re-checked and is the entry's current video; at most one per entry (generated flag + unique index).
CREATE TABLE IF NOT EXISTS video_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  declared_bytes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued',
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  verified_bytes INTEGER,
  etag TEXT,
  current_flag INTEGER GENERATED ALWAYS AS (CASE WHEN status = 'verified' THEN 1 END) STORED,
  CONSTRAINT video_uploads_object_key_uq UNIQUE (object_key),
  CONSTRAINT video_uploads_one_current_uq UNIQUE (submission_id, current_flag),
  CONSTRAINT video_uploads_submission_fk FOREIGN KEY (submission_id) REFERENCES submissions (id),
  CONSTRAINT video_uploads_key_ck CHECK (
    length(object_key) = 36 AND object_key NOT GLOB '*[^0-9a-f-]*'
    AND substr(object_key, 9, 1) = '-' AND substr(object_key, 14, 1) = '-' AND substr(object_key, 19, 1) = '-' AND substr(object_key, 24, 1) = '-'
  ),
  CONSTRAINT video_uploads_type_ck CHECK (content_type IN ('video/mp4', 'video/quicktime', 'video/webm')),
  CONSTRAINT video_uploads_declared_ck CHECK (declared_bytes BETWEEN 102400 AND 104857600),
  CONSTRAINT video_uploads_status_ck CHECK (status IN ('issued', 'verified', 'superseded', 'rejected', 'abandoned', 'deleted')),
  CONSTRAINT video_uploads_expiry_ck CHECK (expires_at > issued_at),
  CONSTRAINT video_uploads_etag_ck CHECK (etag IS NULL OR length(etag) <= 128),
  CONSTRAINT video_uploads_verified_ck CHECK (
    (status <> 'verified' OR (verified_at IS NOT NULL AND verified_bytes IS NOT NULL))
    AND (status IN ('verified', 'superseded', 'deleted') OR (verified_at IS NULL AND verified_bytes IS NULL))
    AND (verified_bytes IS NULL OR verified_bytes BETWEEN 102400 AND 104857600)
  )
) STRICT
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS video_uploads_status_idx ON video_uploads (status, expires_at)
--> statement-breakpoint
DROP TRIGGER IF EXISTS video_uploads_guard_insert
--> statement-breakpoint
CREATE TRIGGER video_uploads_guard_insert BEFORE INSERT ON video_uploads FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: a video can only be uploaded for a draft entry') WHERE (SELECT status FROM submissions WHERE id = NEW.submission_id) <> 'draft';
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS video_uploads_guard_update
--> statement-breakpoint
CREATE TRIGGER video_uploads_guard_update BEFORE UPDATE ON video_uploads FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: an upload cannot be re-pointed')
  WHERE NEW.submission_id <> OLD.submission_id OR NEW.object_key <> OLD.object_key OR NEW.content_type <> OLD.content_type OR NEW.declared_bytes <> OLD.declared_bytes;
  SELECT RAISE(ABORT, 'rule: this upload status change is not allowed')
  WHERE NEW.status <> OLD.status AND NOT (
    (OLD.status = 'issued' AND NEW.status IN ('verified', 'rejected', 'abandoned'))
    OR (OLD.status = 'verified' AND NEW.status IN ('superseded', 'deleted'))
    OR (OLD.status IN ('superseded', 'rejected', 'abandoned') AND NEW.status = 'deleted')
  );
  SELECT RAISE(ABORT, 'rule: the video of a submitted entry cannot be replaced')
  WHERE OLD.status = 'verified' AND NEW.status = 'superseded' AND (SELECT status FROM submissions WHERE id = OLD.submission_id) <> 'draft';
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS video_uploads_no_delete
--> statement-breakpoint
CREATE TRIGGER video_uploads_no_delete BEFORE DELETE ON video_uploads FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'rule: upload rows are kept; mark them deleted instead');
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
