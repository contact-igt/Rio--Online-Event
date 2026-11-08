-- DEV ONLY RECOVERY SCRIPT. NEVER RUN ON PRODUCTION OR ON ANY DATABASE HOLDING REAL ENTRIES.
--
-- Supabase migrations are forward-only. If the M2 migrations must be undone on a DEVELOPMENT
-- database that holds only test data, run this script in the dev project's SQL editor (or with
-- psql against the dev database). It deletes every table, view, function and row created by M2,
-- restores Supabase's standard default privileges for schema public, and clears the migration
-- history so the three M2 migrations can be pushed again.
--
-- It does NOT touch auth.users. Test users created through Supabase Auth must be deleted
-- separately (dashboard: Authentication > Users).
--
-- This file lives outside supabase/migrations on purpose, so the CLI never runs it. A test
-- applies it to a scratch database and checks that nothing from M2 is left behind.

begin;

drop view  if exists public.judge_entries, public.published_winners;

drop table if exists
  public.video_uploads, public.audit_log, public.winners, public.scores, public.judge_assignments,
  public.submissions, public.judge_profiles, public.user_roles,
  public.event_settings, public.events
  cascade;

drop function if exists public.finalize_submission(uuid);
drop function if exists public.withdraw_submission(uuid);
drop function if exists public.unlock_score(uuid);
drop function if exists public.issue_video_upload(uuid, uuid, text, bigint);
drop function if exists public.check_video_upload(uuid, uuid);
drop function if exists public.attach_video_upload(uuid, uuid, bigint, text, text);
drop function if exists public.reject_video_upload(uuid, uuid, text);
drop function if exists public.stale_video_uploads(integer);
drop function if exists public.check_finalize(uuid, uuid);
drop function if exists public.finalize_verified_submission(uuid, uuid, uuid, bigint, text, text);
drop function if exists public.authorize_playback(uuid, uuid);
drop function if exists public.assign_judge_to_event(uuid, smallint);
drop function if exists public.enqueue_participation_email(uuid);
drop function if exists public.claim_participation_email(uuid);
drop function if exists public.finish_participation_email(uuid, text);
drop function if exists public.due_participation_emails(integer);
drop table if exists public.email_outbox;
drop function if exists public.mark_video_upload_deleted(uuid);
drop function if exists public.record_judge_password_reset(uuid, uuid, text);

-- helper and trigger functions all live in schema private
drop schema if exists private cascade;

-- Supabase's standard defaults for objects the migration role creates in schema public
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- forget the migrations so a later push re-applies them (the table only exists on Supabase)
do $$
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    delete from supabase_migrations.schema_migrations
    where version in ('20261105000100', '20261105000200', '20261105000300', '20261105000400', '20261105000500', '20261105000600', '20261105000700', '20261105000800', '20261105000900');
  end if;
end $$;

commit;
