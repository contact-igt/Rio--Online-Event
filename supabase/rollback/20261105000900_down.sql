-- Rollback for 20261105000900_judge_password_gate.sql. NOT a migration: the Supabase CLI does not run this folder.
-- Run by hand, only on a database where 00900 was applied, only with the owner's approval. It restores the 00200, 00300 and 00700 definitions
-- exactly and removes the two new functions. Audit rows already written by record_judge_password_reset stay (the audit log is append-only evidence);
-- they are plain text labels and need no function to be read.
--
-- Effect of rolling back: the first-login rule is enforced by the application only again (see PROJECT_BRIEF.md section 38 and 39).

drop function if exists public.record_judge_password_reset(uuid, uuid, text);

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
  where s.id = p_submission and s.status = 'finalized' and s.video_key is not null;
  if not found then
    raise exception 'not_found';
  end if;
  insert into public.audit_log (actor, action, table_name, row_id, details)
  values (p_judge, 'PLAYBACK_URL', 'submissions', p_submission::text, jsonb_build_object('ttl_seconds', 300));
  return sub.video_key;
end $$;

drop policy assignments_read on public.judge_assignments;
create policy assignments_read on public.judge_assignments
  for select to authenticated
  using (judge_id = (select auth.uid()) or (select private.is_admin()));

create or replace function private.is_judge() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.user_roles r
    join public.judge_profiles p on p.user_id = r.user_id
    where r.user_id = auth.uid() and r.role = 'judge' and p.active
  )
$$;

drop function if exists private.judge_password_pending(uuid);
