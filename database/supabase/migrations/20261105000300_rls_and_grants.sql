-- M2 / 3 of 3: least-privilege grants, row level security, safe projections.
--
-- Supabase grants ALL on new public objects to anon/authenticated by default. Step 1 removes
-- that access from the objects this project creates (by name, so it never touches tables or
-- functions it does not own); step 3 adds back only what each role needs. anon gets no access
-- to any table that holds personal data. A test snapshots every remaining grant.
--
-- Policies call auth.uid() and the private helpers as "(select ...)" so Postgres evaluates them
-- once per statement instead of once per row (Supabase performance advisor 0003).

-- 1. strip default access --------------------------------------------------
-- Deliberate project-wide choice: objects the migration role creates later in schema public are
-- NOT reachable through the API until a migration grants them explicitly.
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

revoke all on table
  public.events, public.event_settings, public.user_roles, public.judge_profiles,
  public.submissions, public.judge_assignments, public.scores, public.winners, public.audit_log
  from public, anon, authenticated;

revoke all on function
  public.finalize_submission(uuid), public.withdraw_submission(uuid), public.unlock_score(uuid)
  from public, anon, authenticated;

do $$
declare r record;
begin
  -- every function in schema private: drop the implicit PUBLIC execute and any default API grants
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'private'::regnamespace
      and p.proowner = (select oid from pg_roles where rolname = current_user)
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;

revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;  -- policies call private.* helpers as the invoker

-- 2. row level security on every table -------------------------------------
alter table public.events            enable row level security;
alter table public.event_settings    enable row level security;
alter table public.user_roles        enable row level security;
alter table public.judge_profiles    enable row level security;
alter table public.submissions       enable row level security;
alter table public.judge_assignments enable row level security;
alter table public.scores            enable row level security;
alter table public.winners           enable row level security;
alter table public.audit_log         enable row level security;

-- events and settings are public information (no personal data)
create policy events_read on public.events
  for select to anon, authenticated using (true);

create policy settings_read on public.event_settings
  for select to anon, authenticated using (true);
create policy settings_admin_update on public.event_settings
  for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- roles: assigned by administrators only; users may read their own row
create policy roles_read on public.user_roles
  for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy roles_admin_insert on public.user_roles
  for insert to authenticated with check ((select private.is_admin()));
create policy roles_admin_update on public.user_roles
  for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy roles_admin_delete on public.user_roles
  for delete to authenticated using ((select private.is_admin()));

create policy judge_profiles_read on public.judge_profiles
  for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy judge_profiles_admin_insert on public.judge_profiles
  for insert to authenticated with check ((select private.is_admin()));
create policy judge_profiles_admin_update on public.judge_profiles
  for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy judge_profiles_admin_delete on public.judge_profiles
  for delete to authenticated using ((select private.is_admin()));

-- submissions: parents see and edit only their own drafts; admins read everything.
-- There is deliberately NO policy for judges: they get zero rows from this table.
create policy submissions_read on public.submissions
  for select to authenticated
  using (owner_id = (select auth.uid()) or (select private.is_admin()));
create policy submissions_owner_insert on public.submissions
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and not (select private.is_staff()));
create policy submissions_owner_update on public.submissions
  for update to authenticated
  using (owner_id = (select auth.uid()) and status in ('draft', 'uploaded'))
  with check (owner_id = (select auth.uid()) and status in ('draft', 'uploaded'));

-- assignments: judges see their own; admins manage
create policy assignments_read on public.judge_assignments
  for select to authenticated
  using (judge_id = (select auth.uid()) or (select private.is_admin()));
create policy assignments_admin_insert on public.judge_assignments
  for insert to authenticated with check ((select private.is_admin()));
create policy assignments_admin_delete on public.judge_assignments
  for delete to authenticated using ((select private.is_admin()));

-- scores: a judge sees and writes only their own marks, only for assigned finalized entries,
-- and only while the row is a draft. Admins can read all (to rank) but not edit.
create policy scores_read on public.scores
  for select to authenticated
  using (
    (judge_id = (select auth.uid()) and (select private.is_judge()))
    or (select private.is_admin())
  );
create policy scores_judge_insert on public.scores
  for insert to authenticated
  with check (judge_id = (select auth.uid()) and private.judge_can_score(submission_id));
create policy scores_judge_update on public.scores
  for update to authenticated
  using (judge_id = (select auth.uid()) and status = 'draft' and private.judge_can_score(submission_id))
  with check (judge_id = (select auth.uid()) and private.judge_can_score(submission_id));

-- winners and audit log: administrators only (the public sees winners through a view)
create policy winners_admin_all on public.winners
  for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy audit_admin_read on public.audit_log
  for select to authenticated using ((select private.is_admin()));

-- 3. grants -----------------------------------------------------------------
grant select on public.events         to anon, authenticated;
grant select on public.event_settings to anon, authenticated;
grant update (submissions_open_at, submissions_close_at, current_consent_version, results_publish_at)
  on public.event_settings to authenticated;

grant select on public.user_roles to authenticated;
grant insert (user_id, role) on public.user_roles to authenticated;
grant update (role)          on public.user_roles to authenticated;
grant delete                 on public.user_roles to authenticated;

grant select on public.judge_profiles to authenticated;
grant insert (user_id, display_name, active) on public.judge_profiles to authenticated;
grant update (display_name, active)          on public.judge_profiles to authenticated;
grant delete                                 on public.judge_profiles to authenticated;

-- Parents may write only the registration fields. status, video_key and the consent timestamp
-- are never client-writable: status moves through finalize/withdraw RPCs, video_key is set
-- by trusted server code (service_role) after the upload is verified.
grant select on public.submissions to authenticated;
grant insert (event_id, child_name, child_age, parent_name, parent_email, parent_mobile, consent_version)
  on public.submissions to authenticated;
grant update (event_id, child_name, child_age, parent_name, parent_email, parent_mobile)
  on public.submissions to authenticated;

grant select on public.judge_assignments to authenticated;
grant insert (judge_id, submission_id) on public.judge_assignments to authenticated;
grant delete                           on public.judge_assignments to authenticated;

grant select on public.scores to authenticated;
grant insert (submission_id, marks, comments, status) on public.scores to authenticated;
grant update (marks, comments, status)                on public.scores to authenticated;

grant select, insert, update, delete on public.winners to authenticated;
grant select on public.audit_log to authenticated;

grant execute on function public.finalize_submission(uuid) to authenticated;
grant execute on function public.withdraw_submission(uuid) to authenticated;
grant execute on function public.unlock_score(uuid)        to authenticated;

-- policies evaluate these as the calling role
grant execute on function private.is_admin()               to authenticated;
grant execute on function private.is_judge()               to authenticated;
grant execute on function private.is_staff()               to authenticated;
grant execute on function private.judge_can_score(uuid)    to authenticated;

-- 4. safe projections -------------------------------------------------------
-- Owned by the migration role, so they read the base tables with its rights; each one lists its
-- columns explicitly and filters on the caller. security_barrier stops callers from pushing their
-- own predicates beneath the filter. These are intentionally security-definer views: Supabase's
-- advisor flags that pattern (0010), and the tests prove they cannot expose personal data.

-- Everything a judge may see: anonymous entry id, event, opaque video reference, own marks.
-- No child or parent field exists in this view, and judges have no route to submissions.
create view public.judge_entries with (security_barrier = true) as
  select
    s.id           as entry_id,
    s.entry_code,
    s.event_id,
    e.name_ta      as event_name_ta,
    e.name_en      as event_name_en,
    s.video_key,
    sc.id          as score_id,
    sc.status      as score_status,
    sc.marks       as my_marks,
    sc.comments    as my_comments
  from public.judge_assignments a
  join public.submissions s on s.id = a.submission_id
  join public.events e      on e.id = s.event_id
  left join public.scores sc on sc.submission_id = s.id and sc.judge_id = a.judge_id
  where (select private.is_judge())
    and a.judge_id = (select auth.uid())
    and s.status = 'finalized';

-- Approved winners, visible only once an admin has set a publish time that has passed.
-- The condition is inlined (not private.results_published()) because Postgres checks EXECUTE on
-- functions called by a view against the caller, and anon must not be granted private functions.
create view public.published_winners with (security_barrier = true) as
  select w.event_id, w.rank, w.award_label, w.display_name
  from public.winners w
  where exists (
    select 1 from public.event_settings s
    where s.results_publish_at is not null and s.results_publish_at <= now()
  );

revoke all on public.judge_entries, public.published_winners from public, anon, authenticated;
grant select on public.judge_entries    to authenticated;
grant select on public.published_winners to anon, authenticated;

-- 5. self-check: fail the migration if any public table lacks RLS -----------
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
