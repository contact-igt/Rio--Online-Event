-- M4B: final submission only through a server-verified path. PREPARED, NOT APPLIED to any hosted project; applying it to the
-- dev project needs explicit approval.
--
-- Why: until now a signed-in parent could call public.finalize_submission(id) straight from the API. It checked ownership,
-- status and the window, but nothing about the video: it could not know whether the stored object still exists or is the
-- one that was verified. Final submission is irreversible for the parent, so the only path to the 'finalized' status must be
-- trusted server code that has just looked at the private bucket.
--
-- What this does (no new status, no new table, no existing table changed):
--   1. drops the parent-callable public.finalize_submission(uuid);
--   2. adds public.check_finalize(owner, submission): a read-only authorization check the server runs BEFORE contacting R2;
--   3. adds public.finalize_verified_submission(...): the single atomic transition uploaded -> finalized, which re-checks
--      everything under row locks and compares the object's CURRENT size, type and ETag (supplied by the server from
--      HeadObject) with the verified record written when the upload was attached.
-- Both new functions are executable by service_role only. status and video_key stay non-writable by parents (migration 3);
-- the submissions_guard trigger still enforces the allowed transitions; the audit trigger records the status change.
--
-- An ETag proves the stored bytes are the bytes that were verified. It is NOT proof of what the video contains or how long it is.

drop function public.finalize_submission(uuid);

-- ---------------------------------------------------------------------------
-- 1. check_finalize: who, what, and is it allowed right now? Read-only. The same generic errors as the other functions, so
-- a stranger learns nothing (an entry that is not theirs and one that does not exist both raise not_found).
-- ---------------------------------------------------------------------------
create function public.check_finalize(p_owner uuid, p_submission uuid)
returns table (upload_id uuid, bytes bigint, content_type text, etag text, event_id smallint, consent_version text, already boolean)
language plpgsql security definer set search_path = '' as $$
declare
  s public.submissions;
  u public.video_uploads;
begin
  select * into s from public.submissions where id = p_submission and owner_id = p_owner;
  if not found then
    raise exception 'not_found';
  end if;
  if s.status = 'finalized' then
    -- idempotent: asking again about an entry that is already final is answered, not refused
    select * into u from public.video_uploads where id = s.video_key and submission_id = s.id and owner_id = p_owner;
    return query select s.video_key, u.verified_bytes, u.content_type, u.etag, s.event_id, s.consent_version, true;
    return;
  end if;
  if s.status <> 'uploaded' then
    raise exception 'invalid_status_transition';
  end if;
  if not private.submissions_open() then
    raise exception 'submissions_closed';
  end if;
  if s.video_key is null then
    raise exception 'video_missing';
  end if;
  select * into u from public.video_uploads where id = s.video_key and submission_id = s.id and owner_id = p_owner;
  if not found or u.status <> 'verified' or u.verified_bytes is null or u.etag is null then
    raise exception 'video_not_verified';
  end if;
  if btrim(s.consent_version) = '' or s.consent_at is null then
    raise exception 'consent_missing';
  end if;
  return query select s.video_key, u.verified_bytes, u.content_type, u.etag, s.event_id, s.consent_version, false;
end $$;

-- ---------------------------------------------------------------------------
-- 2. finalize_verified_submission: the one atomic transition. The server passes what HeadObject reports NOW.
-- Returns 'finalized', or 'already_finalized' when the same entry with the same video is already final (idempotent).
-- ---------------------------------------------------------------------------
create function public.finalize_verified_submission(p_owner uuid, p_submission uuid, p_upload uuid, p_bytes bigint, p_content_type text, p_etag text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  s public.submissions;
  u public.video_uploads;
begin
  -- lock the entry first, then its upload (attach_video_upload locks in the same order, so there is no deadlock)
  select * into s from public.submissions where id = p_submission and owner_id = p_owner for update;
  if not found then
    raise exception 'not_found';
  end if;
  if s.status = 'finalized' then
    if s.video_key is not distinct from p_upload then
      return 'already_finalized'; -- a second request, or a concurrent one that lost the race
    end if;
    raise exception 'submission_locked';
  end if;
  if s.status <> 'uploaded' then
    raise exception 'invalid_status_transition';
  end if;
  if not private.submissions_open() then
    raise exception 'submissions_closed';
  end if;
  if btrim(s.consent_version) = '' or s.consent_at is null then
    raise exception 'consent_missing';
  end if;
  if s.video_key is null or s.video_key <> p_upload then
    raise exception 'video_not_verified'; -- the upload is not this entry's video
  end if;
  select * into u from public.video_uploads where id = p_upload and submission_id = s.id and owner_id = p_owner for update;
  if not found or u.status <> 'verified' then
    raise exception 'video_not_verified';
  end if;
  -- the object as it is in the bucket right now must be the object that was verified
  if u.verified_bytes is distinct from p_bytes or u.content_type is distinct from p_content_type or u.etag is distinct from p_etag then
    raise exception 'video_changed';
  end if;
  begin
    update public.submissions set status = 'finalized' where id = s.id;
  exception when unique_violation then
    raise exception 'duplicate_entry' using errcode = '23505'; -- one finalized entry per child (partial unique index)
  end;
  return 'finalized';
end $$;

-- ---------------------------------------------------------------------------
-- grants: service_role only. Without the revoke, PUBLIC could execute them.
-- ---------------------------------------------------------------------------
revoke all on function
  public.check_finalize(uuid, uuid),
  public.finalize_verified_submission(uuid, uuid, uuid, bigint, text, text)
  from public, anon, authenticated;

grant execute on function
  public.check_finalize(uuid, uuid),
  public.finalize_verified_submission(uuid, uuid, uuid, bigint, text, text)
  to service_role;
