-- M3B: optional media consent, kept separate from the mandatory guardian consent.
--
-- The mandatory guardian consent is already recorded by consent_version (checked against event_settings by the
-- submissions_guard trigger) and consent_at (stamped by the server). This adds ONE column for the separate, optional
-- permission to share the child's entry and first name in event publicity. It defaults to false (no consent), so a
-- registration without the tick behaves exactly as before.
--
-- Additive only: no existing column, policy, trigger or grant is changed. Parents get the same write path as the other
-- registration fields: insert and update of this column, limited by the existing row level security (own rows, draft or
-- uploaded status). Judges never see it (judge_entries does not list it) and finalized rows stay locked by the existing
-- update policy.

alter table public.submissions
  add column media_consent boolean not null default false;

grant insert (media_consent) on public.submissions to authenticated;
grant update (media_consent) on public.submissions to authenticated;
