-- M2 / 2 of 3: role helpers, state-machine triggers, audit triggers, client RPCs.
-- Every function sets search_path = '' and schema-qualifies what it touches.
-- Helpers live in schema "private", which the Supabase API does not expose.

-- ---------------------------------------------------------------------------
-- role and state helpers (SECURITY DEFINER so policies can read user_roles safely)
-- ---------------------------------------------------------------------------
create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'admin')
$$;

create function private.is_judge() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.user_roles r
    join public.judge_profiles p on p.user_id = r.user_id
    where r.user_id = auth.uid() and r.role = 'judge' and p.active
  )
$$;

-- any staff account (admin or judge, active or not); staff cannot register children
create function private.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_roles r where r.user_id = auth.uid())
$$;

create function private.submissions_open() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.event_settings s
    where s.submissions_open_at is not null and s.submissions_close_at is not null
      and now() >= s.submissions_open_at and now() < s.submissions_close_at
  )
$$;

create function private.results_published() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.event_settings s
    where s.results_publish_at is not null and s.results_publish_at <= now()
  )
$$;

-- a judge may score a submission only if assigned to it and it is finalized
create function private.judge_can_score(p_submission uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_judge()
    and exists (select 1 from public.judge_assignments a where a.judge_id = auth.uid() and a.submission_id = p_submission)
    and exists (select 1 from public.submissions s where s.id = p_submission and s.status = 'finalized')
$$;

-- ---------------------------------------------------------------------------
-- submissions: validation and status transitions
-- ---------------------------------------------------------------------------
create function private.submissions_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ev public.events;
  cfg public.event_settings;
begin
  select * into ev from public.events where id = new.event_id;

  if tg_op = 'INSERT' then
    select * into cfg from public.event_settings;
    if not private.submissions_open() then
      raise exception 'submissions_closed';
    end if;
    if new.status <> 'draft' or new.video_key is not null then
      raise exception 'new_submission_must_be_draft';
    end if;
    if cfg.current_consent_version is null or new.consent_version is distinct from cfg.current_consent_version then
      raise exception 'consent_version_mismatch';
    end if;
    new.consent_at := now();
    new.created_at := now();
    new.updated_at := now();
    new.finalized_at := null;
    new.withdrawn_at := null;
  else
    if new.id <> old.id or new.owner_id <> old.owner_id or new.entry_code <> old.entry_code
       or new.consent_version <> old.consent_version or new.consent_at <> old.consent_at
       or new.age_as_of <> old.age_as_of or new.created_at <> old.created_at then
      raise exception 'immutable_column';
    end if;
    if old.status = 'withdrawn' then
      raise exception 'submission_locked';
    end if;
    if not ((old.status, new.status) in (
      ('draft', 'draft'), ('draft', 'uploaded'), ('draft', 'withdrawn'),
      ('uploaded', 'uploaded'), ('uploaded', 'finalized'), ('uploaded', 'withdrawn'),
      ('finalized', 'finalized'), ('finalized', 'withdrawn')
    )) then
      raise exception 'invalid_status_transition';
    end if;
    if old.status = 'finalized' and (
      row(new.event_id, new.child_name, new.child_age, new.parent_name, new.parent_email, new.parent_mobile, new.video_key)
      is distinct from
      row(old.event_id, old.child_name, old.child_age, old.parent_name, old.parent_email, old.parent_mobile, old.video_key)
    ) then
      raise exception 'submission_locked';
    end if;
    new.finalized_at := case when new.status = 'finalized' and old.status <> 'finalized' then now() else old.finalized_at end;
    new.withdrawn_at := case when new.status = 'withdrawn' then now() else old.withdrawn_at end;
    new.updated_at := now();
  end if;

  if new.child_age < ev.min_age or new.child_age > ev.max_age then
    raise exception 'age_not_eligible';
  end if;
  return new;
end $$;

create trigger submissions_guard before insert or update on public.submissions
  for each row execute function private.submissions_guard();

-- ---------------------------------------------------------------------------
-- scores: independent per judge; a final score is locked unless an admin unlocks it
-- ---------------------------------------------------------------------------
create function private.scores_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    new.finalized_at := case when new.status = 'final' then now() end;
  else
    if new.id <> old.id or new.judge_id <> old.judge_id or new.submission_id <> old.submission_id then
      raise exception 'immutable_column';
    end if;
    if old.status = 'final' then
      if new.status = 'draft' then
        if not private.is_admin() then
          raise exception 'score_locked';
        end if;
        new.finalized_at := null;
      elsif new.status <> old.status or new.marks is distinct from old.marks or new.comments is distinct from old.comments then
        raise exception 'score_locked';
      else
        new.finalized_at := old.finalized_at;
      end if;
    else
      new.finalized_at := case when new.status = 'final' then now() end;
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;

create trigger scores_guard before insert or update on public.scores
  for each row execute function private.scores_guard();

-- ---------------------------------------------------------------------------
-- assignments, winners, settings, roles
-- ---------------------------------------------------------------------------
create function private.assignments_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.submissions s where s.id = new.submission_id and s.status = 'finalized') then
    raise exception 'submission_not_finalized';
  end if;
  new.assigned_by := auth.uid();
  new.assigned_at := now();
  return new;
end $$;

create trigger assignments_guard before insert on public.judge_assignments
  for each row execute function private.assignments_guard();

create function private.winners_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  sub public.submissions;
begin
  select * into sub from public.submissions where id = new.submission_id;
  if tg_op = 'UPDATE' and (new.submission_id <> old.submission_id or new.event_id <> old.event_id) then
    raise exception 'immutable_column';
  end if;
  if sub.id is null or sub.status <> 'finalized' then
    raise exception 'submission_not_finalized';
  end if;
  if sub.event_id <> new.event_id then
    raise exception 'event_mismatch';
  end if;
  if tg_op = 'INSERT' then
    -- the approver is always the signed-in administrator, never client-supplied
    new.approved_by := auth.uid();
    new.approved_at := now();
    if new.approved_by is null then
      raise exception 'approver_required';
    end if;
  else
    new.approved_by := old.approved_by;
    new.approved_at := old.approved_at;
  end if;
  return new;
end $$;

create trigger winners_guard before insert or update on public.winners
  for each row execute function private.winners_guard();

create function private.settings_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger settings_guard before update on public.event_settings
  for each row execute function private.settings_guard();

create function private.roles_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.granted_by := auth.uid();
    new.granted_at := now();
    return new;
  end if;
  if tg_op = 'UPDATE' and new.user_id <> old.user_id then
    raise exception 'immutable_column';
  end if;
  -- never leave the system without an administrator
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin') then
    if not exists (select 1 from public.user_roles r where r.role = 'admin' and r.user_id <> old.user_id) then
      raise exception 'last_admin';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger roles_guard before insert or update or delete on public.user_roles
  for each row execute function private.roles_guard();

-- ---------------------------------------------------------------------------
-- audit: only ids and non-personal state fields are recorded
-- ---------------------------------------------------------------------------
create function private.audit_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  tracked constant text[] := array[
    'status', 'role', 'active', 'rank',
    'results_publish_at', 'submissions_open_at', 'submissions_close_at', 'current_consent_version'
  ];
  src jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  rid text := '';
  k text;
begin
  foreach k in array tg_argv loop
    rid := rid || case when rid = '' then '' else ':' end || coalesce(src ->> k, '');
  end loop;
  insert into public.audit_log (actor, action, table_name, row_id, details)
  values (
    auth.uid(), tg_op, tg_table_name, rid,
    jsonb_build_object(
      'old', case when tg_op = 'INSERT' then '{}'::jsonb
                  else coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(to_jsonb(old)) e where e.key = any (tracked)), '{}'::jsonb) end,
      'new', case when tg_op = 'DELETE' then '{}'::jsonb
                  else coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(to_jsonb(new)) e where e.key = any (tracked)), '{}'::jsonb) end
    )
  );
  return null;
end $$;

create trigger audit_submissions   after insert or update or delete on public.submissions       for each row execute function private.audit_change('id');
create trigger audit_scores        after insert or update or delete on public.scores            for each row execute function private.audit_change('id');
create trigger audit_winners       after insert or update or delete on public.winners           for each row execute function private.audit_change('id');
create trigger audit_user_roles    after insert or update or delete on public.user_roles        for each row execute function private.audit_change('user_id');
create trigger audit_judge_profile after insert or update or delete on public.judge_profiles    for each row execute function private.audit_change('user_id');
create trigger audit_assignments   after insert or update or delete on public.judge_assignments for each row execute function private.audit_change('judge_id', 'submission_id');
create trigger audit_settings      after update on public.event_settings                        for each row execute function private.audit_change('id');

-- ---------------------------------------------------------------------------
-- client RPCs. These are the only way a client changes a submission's status.
-- Errors are deliberately generic so one parent cannot probe another's entries.
-- ---------------------------------------------------------------------------
create function public.finalize_submission(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.submissions;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  select * into s from public.submissions where id = p_id and owner_id = auth.uid() for update;
  if not found then
    raise exception 'not_found';
  end if;
  if s.status <> 'uploaded' then
    raise exception 'invalid_status_transition';
  end if;
  if not private.submissions_open() then
    raise exception 'submissions_closed';
  end if;
  begin
    update public.submissions set status = 'finalized' where id = p_id;
  exception when unique_violation then
    raise exception 'duplicate_entry' using errcode = '23505';
  end;
end $$;

create function public.withdraw_submission(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.submissions;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  select * into s from public.submissions where id = p_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  if private.is_admin() then
    null; -- administrators may withdraw any entry (takedown)
  elsif s.owner_id = auth.uid() and s.status in ('draft', 'uploaded') then
    null; -- a parent may withdraw only before finalizing
  else
    raise exception 'not_found';
  end if;
  update public.submissions set status = 'withdrawn' where id = p_id;
end $$;

create function public.unlock_score(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then
    raise exception 'forbidden';
  end if;
  update public.scores set status = 'draft' where id = p_id and status = 'final';
  if not found then
    raise exception 'not_found';
  end if;
end $$;
