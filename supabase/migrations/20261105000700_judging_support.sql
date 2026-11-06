-- M5/M6: judging support. PREPARED, NOT APPLIED to any hosted project; applying it to the dev project needs explicit approval.
-- Requires 00600. Adds exactly two functions and changes nothing else (no table, column, policy, grant on a table or view).
--
-- 1. authorize_playback: the ONLY way the app learns which private object a judge may be shown. Called by trusted server code
--    (service role) with the judge's id taken from the verified session. It re-checks, in the database, that the judge is an
--    active judge, is assigned to this entry, and the entry is finalized and has a video; then it writes an audit row (ids only,
--    no personal data) BEFORE returning the opaque video id. The app then signs a GET URL that lives five minutes.
--    A judge who is not assigned, an inactive judge, a draft entry and an unknown entry all get the identical 'not_found'.
-- 2. assign_judge_to_event: an administrator assigns a judge to a competition, meaning every finalized entry in it that the judge
--    does not already have. Idempotent (running it again adds only entries finalized since), returns how many were added. The
--    existing assignment trigger stamps who assigned and the audit trigger records each row.

create function public.authorize_playback(p_judge uuid, p_submission uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  sub public.submissions;
begin
  if p_judge is null or p_submission is null then
    raise exception 'not_found';
  end if;
  select s.* into sub
  from public.submissions s
  join public.judge_assignments a on a.submission_id = s.id and a.judge_id = p_judge
  join public.judge_profiles jp on jp.user_id = p_judge and jp.active
  join public.user_roles r on r.user_id = p_judge and r.role = 'judge'
  where s.id = p_submission and s.status = 'finalized' and s.video_key is not null;
  if not found then
    raise exception 'not_found';
  end if;
  insert into public.audit_log (actor, action, table_name, row_id, details)
  values (p_judge, 'PLAYBACK_URL', 'submissions', p_submission::text, jsonb_build_object('ttl_seconds', 300));
  return sub.video_key;
end $$;

revoke all on function public.authorize_playback(uuid, uuid) from public, anon, authenticated;
grant execute on function public.authorize_playback(uuid, uuid) to service_role;

create function public.assign_judge_to_event(p_judge uuid, p_event smallint)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  added integer;
begin
  if not private.is_admin() then
    raise exception 'forbidden';
  end if;
  if not exists (select 1 from public.judge_profiles jp where jp.user_id = p_judge and jp.active) then
    raise exception 'judge_not_found';
  end if;
  if not exists (select 1 from public.events e where e.id = p_event) then
    raise exception 'event_not_found';
  end if;
  insert into public.judge_assignments (judge_id, submission_id)
  select p_judge, s.id from public.submissions s where s.event_id = p_event and s.status = 'finalized'
  on conflict do nothing;
  get diagnostics added = row_count;
  return added;
end $$;

revoke all on function public.assign_judge_to_event(uuid, smallint) from public, anon, authenticated;
grant execute on function public.assign_judge_to_event(uuid, smallint) to authenticated;
