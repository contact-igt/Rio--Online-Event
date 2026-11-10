-- One row per signed upload. The video itself is in the private R2 bucket under `object_key` (a random UUID, never derived from a name).
-- The size and type limits are the ones in website/lib/upload/rules.ts (100 KB to 100 MB; mp4, quicktime, webm).
-- `verified` means the stored object was re-checked and is the entry's current video; at most one per entry (generated flag + unique key).
CREATE TABLE IF NOT EXISTS video_uploads (
  id BIGINT NOT NULL AUTO_INCREMENT,
  submission_id BIGINT NOT NULL,
  object_key CHAR(36) COLLATE utf8mb4_0900_bin NOT NULL,
  content_type VARCHAR(20) COLLATE utf8mb4_0900_bin NOT NULL,
  declared_bytes BIGINT NOT NULL,
  status VARCHAR(12) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'issued',
  issued_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  expires_at DATETIME(3) NOT NULL,
  verified_at DATETIME(3) NULL,
  verified_bytes BIGINT NULL,
  etag VARCHAR(128) COLLATE utf8mb4_0900_bin NULL,
  current_flag TINYINT GENERATED ALWAYS AS (IF(status = 'verified', 1, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY video_uploads_object_key_uq (object_key),
  UNIQUE KEY video_uploads_one_current_uq (submission_id, current_flag),
  KEY video_uploads_status_idx (status, expires_at),
  CONSTRAINT video_uploads_submission_fk FOREIGN KEY (submission_id) REFERENCES submissions (id),
  CONSTRAINT video_uploads_key_ck CHECK (object_key REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT video_uploads_type_ck CHECK (content_type IN ('video/mp4', 'video/quicktime', 'video/webm')),
  CONSTRAINT video_uploads_declared_ck CHECK (declared_bytes BETWEEN 102400 AND 104857600),
  CONSTRAINT video_uploads_status_ck CHECK (status IN ('issued', 'verified', 'superseded', 'rejected', 'abandoned', 'deleted')),
  CONSTRAINT video_uploads_expiry_ck CHECK (expires_at > issued_at),
  CONSTRAINT video_uploads_verified_ck CHECK (
    (status <> 'verified' OR (verified_at IS NOT NULL AND verified_bytes IS NOT NULL))
    AND (status IN ('verified', 'superseded', 'deleted') OR (verified_at IS NULL AND verified_bytes IS NULL))
    AND (verified_bytes IS NULL OR verified_bytes BETWEEN 102400 AND 104857600)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
--> statement-breakpoint
DROP TRIGGER IF EXISTS video_uploads_guard_insert
--> statement-breakpoint
CREATE TRIGGER video_uploads_guard_insert BEFORE INSERT ON video_uploads FOR EACH ROW
BEGIN
  IF (SELECT status FROM submissions WHERE id = NEW.submission_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: a video can only be uploaded for a draft entry';
  END IF;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS video_uploads_guard_update
--> statement-breakpoint
CREATE TRIGGER video_uploads_guard_update BEFORE UPDATE ON video_uploads FOR EACH ROW
BEGIN
  IF NEW.submission_id <> OLD.submission_id OR NEW.object_key <> OLD.object_key OR NEW.content_type <> OLD.content_type OR NEW.declared_bytes <> OLD.declared_bytes THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: an upload cannot be re-pointed';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'issued' AND NEW.status IN ('verified', 'rejected', 'abandoned'))
    OR (OLD.status = 'verified' AND NEW.status IN ('superseded', 'deleted'))
    OR (OLD.status IN ('superseded', 'rejected', 'abandoned') AND NEW.status = 'deleted')
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: this upload status change is not allowed';
  END IF;
  IF OLD.status = 'verified' AND NEW.status = 'superseded' AND (SELECT status FROM submissions WHERE id = OLD.submission_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: the video of a submitted entry cannot be replaced';
  END IF;
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS video_uploads_no_delete
--> statement-breakpoint
CREATE TRIGGER video_uploads_no_delete BEFORE DELETE ON video_uploads FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: upload rows are kept; mark them deleted instead';
END
--> statement-breakpoint
DROP TRIGGER IF EXISTS submissions_require_video
--> statement-breakpoint
CREATE TRIGGER submissions_require_video BEFORE UPDATE ON submissions FOR EACH ROW
BEGIN
  IF NEW.status IN ('held', 'finalized') AND NEW.status <> OLD.status THEN
    IF NOT EXISTS (SELECT 1 FROM video_uploads WHERE submission_id = NEW.id AND status = 'verified') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: an entry needs a verified video before it is submitted';
    END IF;
  END IF;
END
