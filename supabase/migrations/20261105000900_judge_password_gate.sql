-- M9: judge first-login password gate in the database, and a labelled audit event for judge password resets.
-- PREPARED, NOT APPLIED to any hosted project; applying it to DEV or production needs explicit approval. Requires 00700 (it replaces one 00700 function).
-- Tested only on isolated local databases (supabase/tests/judge-password-gate.test.ts). Rollback: supabase/rollback/20261105000900_down.sql (not run by the CLI).
--
-- WHY. When an administrator creates a judge or resets a judge's password, the account carries app_metadata.must_change_password = true. Until now
-- only the application enforced it. A judge holding the initial password could call the Supabase Data API directly (their own token is valid) and read
-- their assigned entries or write scores. This migration moves the rule into the database.
--
-- TRUSTED STATE, NOT THE TOKEN. The mark is read from auth.users.raw_app_meta_data on every call, never from the JWT's claims, so a token issued
-- before a reset (valid until it expires, up to an hour) is refused as soon as the mark is set, and a token issued before the judge changed the password
-- keeps working only after the mark is lifted. Only the secret key (Auth admin API) can write app_metadata; a signed-in user can edit only
-- user_metadata, which is not read here. If the account row is missing the answer is "pending" (fail closed).
--
-- WHAT IT CHANGES (no table, column, grant on a table, or exposure of auth.users to any client role):
--   1. private.judge_password_pending(uuid): new, SECURITY DEFINER, executable by nobody but the functions below (they run as their owner). It is the
--      only code that reads auth.users; authenticated and anon cannot call it and cannot read auth.users.
--   2. private.is_judge(): now also requires "no password change pending". Every judge path already goes through it: judge_entries (the entries a
--      judge may see), scores_read, scores_judge_insert / scores_judge_update (through judge_can_score). A pending judge therefore reads no entry and
--      reads or writes no score. Parent and administrator paths do not use it and are unchanged.
--   3. assignments_read: a judge reads their own assignment rows only when is_judge() holds (before: any judge, even a deactivated one, could list the
--      opaque ids of their assigned entries). Administrators are unchanged.
--   4. public.authorize_playback: same body as 00700 plus the same check, so a pending judge cannot obtain a video reference even if called with the
--      service role by mistake. Still service-role only.
--   5. public.record_judge_password_reset(actor, judge, outcome): new, service-role only. Writes ONE audit row labelled JUDGE_PASSWORD_RESET_STARTED,
--      JUDGE_PASSWORD_RESET (success) or JUDGE_PASSWORD_RESET_FAILED, with the acting administrator, the target judge, the time, and nothing else (no
--      password, no hash, no e-mail, no name). It checks that the actor is an administrator and the target a judge. Because only the server (secret
--      key) can call it, an administrator cannot forge or skip these rows through the Data API, and a reset no longer touches judge_profiles.
--
-- WHAT A PENDING JUDGE CAN STILL DO through the Data API: read their own role row and profile (the app needs them to send the judge to the set-password
-- page), and read public data (competitions, settings, published winners). Nothing else.

create function private.judge_password_pending(p_user uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from auth.users u where u.id = p_user)
      or exists (select 1 from auth.users u where u.id = p_user and coalesce(u.raw_app_meta_data ->> 'must_change_password', '') = 'true')
$$;

revoke all on function private.judge_password_pending(uuid) from public, anon, authenticated;

create or replace function private.is_judge() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.user_roles r
    join public.judge_profiles p on p.user_id = r.user_id
    where r.user_id = auth.uid() and r.role = 'judge' and p.active
      and not private.judge_password_pending(r.user_id)
  )
$$;

drop policy assignments_read on public.judge_assignments;
create policy assignments_read on public.judge_assignments
  for select to authenticated
  using ((judge_id = (select auth.uid()) and (select private.is_judge())) or (select private.is_admin()));

create or replace function public.authorize_playback(p_judge uuid, p_submission uuid)
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
  where s.id = p_submission and s.status = 'finalized' and s.video_key is not null
    and not private.judge_password_pending(p_judge);
  if not found then
    raise exception 'not_found';
  end if;
  insert into public.audit_log (actor, action, table_name, row_id, details)
  values (p_judge, 'PLAYBACK_URL', 'submissions', p_submission::text, jsonb_build_object('ttl_seconds', 300));
  return sub.video_key;
end $$;

create function public.record_judge_password_reset(p_actor uuid, p_judge uuid, p_outcome text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_outcome is null or p_outcome not in ('started', 'success', 'failed') then
    raise exception 'invalid_outcome';
  end if;
  if p_actor is null or not exists (select 1 from public.user_roles r where r.user_id = p_actor and r.role = 'admin') then
    raise exception 'forbidden';
  end if;
  if p_judge is null or not exists (select 1 from public.judge_profiles jp where jp.user_id = p_judge) then
    raise exception 'judge_not_found';
  end if;
  insert into public.audit_log (actor, action, table_name, row_id, details)
  values (
    p_actor,
    case p_outcome when 'started' then 'JUDGE_PASSWORD_RESET_STARTED' when 'success' then 'JUDGE_PASSWORD_RESET' else 'JUDGE_PASSWORD_RESET_FAILED' end,
    'judge_profiles',
    p_judge::text,
    jsonb_build_object('outcome', p_outcome)
  );
end $$;

revoke all on function public.record_judge_password_reset(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_judge_password_reset(uuid, uuid, text) to service_role;
