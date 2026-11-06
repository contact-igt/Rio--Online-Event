-- M4A: private video upload bookkeeping. PREPARED, NOT APPLIED to any hosted project; applying it to the dev
-- project needs explicit approval.
--
-- Why a table: the browser uploads straight to a private Cloudflare R2 bucket with a short-lived presigned URL. Each
-- URL is backed by one row here, created only by trusted server code. The row id IS the opaque object name
-- (pending/<id>, then videos/<id>), so a client can never choose or guess an object key, an authorization can be used
-- once, a retry gets a fresh id, and abandoned objects can be found and removed.
--
-- Who can do what: nobody but service_role. The table has RLS enabled and no policy, and every function below is
-- executable by service_role only. The app calls them after it has checked the parent's own signed-in session, and
-- passes that parent's id; the functions re-check ownership, status and the registration window themselves.
-- submissions.video_key and submissions.status are still never client-writable (migration 3 is unchanged).

create table public.video_uploads (
  id              uuid primary key default gen_random_uuid(),
  submission_id   uuid not null references public.submissions (id) on delete cascade,
  owner_id        uuid not null references auth.users (id) on delete cascade,
  content_type    text not null check (content_type in ('video/mp4', 'video/quicktime', 'video/webm')),
  -- 100 KB to 100 MB, as declared by the browser and later compared with what R2 actually stored
  declared_bytes  bigint not null check (declared_bytes between 102400 and 104857600),
  status          text not null default 'issued'
                  check (status in ('issued', 'verified', 'superseded', 'rejected', 'abandoned', 'deleted')),
  issued_at       timestamptz not null default now(),
  expires_at      timestamptz not null,
  verified_at     timestamptz,
  verified_bytes  bigint,
  etag            text,
  constraint video_uploads_verified_fields check (
    (status in ('verified', 'superseded', 'deleted')) or (verified_at is null and verified_bytes is null)
  )
);

create index video_uploads_submission_idx on public.video_uploads (submission_id, status);
create index video_uploads_owner_idx on public.video_uploads (owner_id, issued_at);
create index video_uploads_status_idx on public.video_uploads (status, expires_at);

alter table public.video_uploads enable row level security;
revoke all on table public.video_uploads from public, anon, authenticated;

-- issuing a signed upload and every status change leave an audit row (ids and states only)
create trigger audit_video_uploads after insert or update on public.video_uploads
  for each row execute function private.audit_change('id');

-- ---------------------------------------------------------------------------
-- 1. issue: a parent may start an upload only for their own draft or uploaded entry while registration is open
-- ---------------------------------------------------------------------------
create function public.issue_video_upload(p_owner uuid, p_submission uuid, p_content_type text, p_bytes bigint)
returns table (upload_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  s public.submissions;
  new_id uuid;
  new_expiry timestamptz := now() + interval '15 minutes';
begin
  if p_owner is null then
    raise exception 'not_authenticated';
  end if;
  -- the same answer for "does not exist" and "belongs to someone else"
  select * into s from public.submissions where id = p_submission and owner_id = p_owner for update;
  if not found then
    raise exception 'not_found';
  end if;
  if s.status not in ('draft', 'uploaded') then
    raise exception 'submission_locked';
  end if;
  if not private.submissions_open() then
    raise exception 'submissions_closed';
  end if;
  if p_content_type not in ('video/mp4', 'video/quicktime', 'video/webm') or p_bytes is null
     or p_bytes < 102400 or p_bytes > 104857600 then
    raise exception 'invalid_video';
  end if;
  -- bounded issuance: per entry per hour, and per parent per day
  if (select count(*) from public.video_uploads u where u.submission_id = p_submission and u.issued_at > now() - interval '1 hour') >= 8
     or (select count(*) from public.video_uploads u where u.owner_id = p_owner and u.issued_at > now() - interval '1 day') >= 30 then
    raise exception 'too_many_uploads';
  end if;
  -- a new authorization retires every older unused one for this entry
  update public.video_uploads u set status = 'superseded' where u.submission_id = p_submission and u.status = 'issued';
  insert into public.video_uploads (submission_id, owner_id, content_type, declared_bytes, expires_at)
  values (p_submission, p_owner, p_content_type, p_bytes, new_expiry)
  returning id into new_id;
  return query select new_id, new_expiry;
end $$;

-- ---------------------------------------------------------------------------
-- 1b. check: the FIRST step of confirming an upload, before the bucket is contacted at all. It is read-only and answers
-- with the same generic errors as the other functions, so a stranger learns nothing (an upload that is not theirs and
-- one that does not exist both raise not_found). On success it returns what was declared, so the server can compare
-- the stored object with it before copying anything.
-- ---------------------------------------------------------------------------
create function public.check_video_upload(p_owner uuid, p_upload uuid)
returns table (declared_bytes bigint, content_type text)
language plpgsql security definer set search_path = '' as $$
declare
  u public.video_uploads;
  s public.submissions;
begin
  select * into u from public.video_uploads where id = p_upload and owner_id = p_owner;
  if not found then
    raise exception 'not_found';
  end if;
  select * into s from public.submissions where id = u.submission_id and owner_id = p_owner;
  if not found then
    raise exception 'not_found';
  end if;
  if u.status <> 'issued' then
    raise exception 'upload_not_current';
  end if;
  if now() > u.expires_at + interval '10 minutes' then
    raise exception 'upload_expired';
  end if;
  if s.status not in ('draft', 'uploaded') then
    raise exception 'submission_locked';
  end if;
  if not private.submissions_open() then
    raise exception 'submissions_closed';
  end if;
  return query select u.declared_bytes, u.content_type;
end $$;

-- ---------------------------------------------------------------------------
-- 2. attach: called only after the server has seen the stored object (HeadObject) match the declaration.
-- It re-checks everything check_video_upload checked, under row locks, so nothing can change in between.
-- ---------------------------------------------------------------------------
create function public.attach_video_upload(p_owner uuid, p_upload uuid, p_bytes bigint, p_content_type text, p_etag text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  u public.video_uploads;
  s public.submissions;
  sid uuid;
  previous uuid;
begin
  -- lock the entry first, then the authorization (issue_video_upload locks in the same order, so no deadlock)
  select submission_id into sid from public.video_uploads where id = p_upload and owner_id = p_owner;
  if not found then
    raise exception 'not_found';
  end if;
  select * into s from public.submissions where id = sid and owner_id = p_owner for update;
  if not found then
    raise exception 'not_found';
  end if;
  select * into u from public.video_uploads where id = p_upload and owner_id = p_owner for update;
  if not found then
    raise exception 'not_found';
  end if;
  -- single use: only an unused, current authorization can be attached
  if u.status <> 'issued' then
    raise exception 'upload_not_current';
  end if;
  if now() > u.expires_at + interval '10 minutes' then
    raise exception 'upload_expired';
  end if;
  if p_bytes is distinct from u.declared_bytes then
    raise exception 'size_mismatch';
  end if;
  if p_content_type is distinct from u.content_type then
    raise exception 'type_mismatch';
  end if;
  if s.status not in ('draft', 'uploaded') then
    raise exception 'submission_locked';
  end if;
  if not private.submissions_open() then
    raise exception 'submissions_closed';
  end if;
  previous := s.video_key;
  update public.submissions set video_key = p_upload, status = 'uploaded' where id = s.id;
  update public.video_uploads set status = 'verified', verified_at = now(), verified_bytes = p_bytes, etag = p_etag where id = p_upload;
  if previous is not null then
    update public.video_uploads set status = 'superseded' where id = previous and status = 'verified';
  end if;
  return previous; -- the replaced video, now queued for deletion by the cleanup job
end $$;

-- ---------------------------------------------------------------------------
-- 3. reject: the stored object did not match; the authorization is dead and the object is queued for deletion
-- ---------------------------------------------------------------------------
create function public.reject_video_upload(p_owner uuid, p_upload uuid, p_status text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('rejected', 'abandoned') then
    raise exception 'invalid_status';
  end if;
  update public.video_uploads set status = p_status
  where id = p_upload and owner_id = p_owner and status = 'issued';
  if not found then
    raise exception 'upload_not_current';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. cleanup: ids whose objects should be deleted, and the bookkeeping for it. Run by a server-side job
-- (scripts/cleanup-uploads.ts); nothing here deletes an object itself.
-- ---------------------------------------------------------------------------
create function public.stale_video_uploads(p_limit integer default 100)
returns setof uuid
language plpgsql security definer set search_path = '' as $$
begin
  -- an authorization that was never used and is long past its expiry is abandoned
  update public.video_uploads set status = 'abandoned'
  where status = 'issued' and expires_at < now() - interval '1 hour';
  return query
    select u.id from public.video_uploads u
    where u.status in ('superseded', 'rejected', 'abandoned')
    order by u.issued_at
    limit greatest(1, least(coalesce(p_limit, 100), 500));
end $$;

create function public.mark_video_upload_deleted(p_upload uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.video_uploads set status = 'deleted'
  where id = p_upload and status in ('superseded', 'rejected', 'abandoned');
end $$;

-- ---------------------------------------------------------------------------
-- grants: service_role only. Without the revoke, PUBLIC could execute them.
-- ---------------------------------------------------------------------------
revoke all on function
  public.issue_video_upload(uuid, uuid, text, bigint),
  public.check_video_upload(uuid, uuid),
  public.attach_video_upload(uuid, uuid, bigint, text, text),
  public.reject_video_upload(uuid, uuid, text),
  public.stale_video_uploads(integer),
  public.mark_video_upload_deleted(uuid)
  from public, anon, authenticated;

grant execute on function
  public.issue_video_upload(uuid, uuid, text, bigint),
  public.check_video_upload(uuid, uuid),
  public.attach_video_upload(uuid, uuid, bigint, text, text),
  public.reject_video_upload(uuid, uuid, text),
  public.stale_video_uploads(integer),
  public.mark_video_upload_deleted(uuid)
  to service_role;

-- self-check: this migration must not leave a table without RLS
do $$
declare missing text;
begin
  select string_agg(c.relname, ', ') into missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if missing is not null then
    raise exception 'RLS disabled on: %', missing;
  end if;
end $$;
