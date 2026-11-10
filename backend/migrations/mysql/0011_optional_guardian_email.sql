-- The guardian's e-mail address is optional (M4): there are no parent accounts, and the recovery code is shown on screen, so an address is only
-- a convenience. The existing CHECK (lower-case, one @, no spaces) stays; a NULL passes a CHECK, so it still applies whenever an address is given.
ALTER TABLE submissions MODIFY guardian_email VARCHAR(254) COLLATE utf8mb4_0900_bin NULL
--> statement-breakpoint
-- The trigger that freezes a submitted entry compared the address with <>, which says "no difference" as soon as either side is NULL. Compare null-safely.
DROP TRIGGER IF EXISTS submissions_guard_update
--> statement-breakpoint
CREATE TRIGGER submissions_guard_update BEFORE UPDATE ON submissions FOR EACH ROW
BEGIN
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('held', 'finalized', 'withdrawn'))
    OR (OLD.status = 'held' AND NEW.status IN ('finalized', 'rejected', 'withdrawn'))
    OR (OLD.status = 'finalized' AND NEW.status = 'withdrawn')
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: this status change is not allowed';
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.entry_code <> OLD.entry_code OR NEW.event_id <> OLD.event_id OR NEW.question_set_id <> OLD.question_set_id
    OR NEW.child_name <> OLD.child_name OR NEW.child_name_norm <> OLD.child_name_norm OR NEW.child_age <> OLD.child_age
    OR NEW.guardian_name <> OLD.guardian_name OR NEW.guardian_mobile <> OLD.guardian_mobile OR NOT (NEW.guardian_email <=> OLD.guardian_email)
    OR NOT (NEW.guardian_consent_version <=> OLD.guardian_consent_version) OR NOT (NEW.guardian_consent_at <=> OLD.guardian_consent_at)
    OR NOT (NEW.media_consent <=> OLD.media_consent) OR NOT (NEW.media_consent_version <=> OLD.media_consent_version) OR NOT (NEW.media_consent_at <=> OLD.media_consent_at)
    OR NOT (NEW.submitted_at <=> OLD.submitted_at)
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: a submitted entry cannot be edited';
  END IF;
  IF OLD.status = 'draft' AND (NEW.child_age <> OLD.child_age OR NEW.event_id <> OLD.event_id) THEN
    IF NEW.child_age < (SELECT min_age FROM events WHERE id = NEW.event_id) OR NEW.child_age > (SELECT max_age FROM events WHERE id = NEW.event_id) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: the child age is outside the competition range';
    END IF;
  END IF;
  IF OLD.status = 'draft' AND NEW.question_set_id <> OLD.question_set_id THEN
    IF (SELECT status FROM question_sets WHERE id = NEW.question_set_id) <> 'published' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'rule: an entry must use the published question set';
    END IF;
  END IF;
END
