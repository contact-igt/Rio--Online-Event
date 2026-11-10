-- M2 / 1 of 3: core tables and reference data.
-- Hard rules encoded here (see PROJECT_BRIEF.md section 2 and 4):
--   * no date of birth is stored; age is declared in whole years as of 2026-11-14
--   * the video is referenced only by an opaque uuid, never by a URL
--   * one finalized submission per child (normalized parent mobile + child name)
--   * judges never get parent/child data (enforced by RLS and grants in migration 3)

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- events: the six competitions. Keep in sync with lib/events.ts (a test compares them).
-- ---------------------------------------------------------------------------
create table public.events (
  id        smallint primary key check (id between 1 and 99),
  slug      text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name_ta   text not null check (length(btrim(name_ta)) > 0),
  name_en   text not null check (length(btrim(name_en)) > 0),
  min_age   smallint not null,
  max_age   smallint not null,
  constraint events_age_band check (min_age between 3 and 12 and max_age between 3 and 12 and min_age <= max_age)
);

insert into public.events (id, slug, name_ta, name_en, min_age, max_age) values
  (1, 'malalai-mozhi',          'மழலை மொழி',              'Toddler Tamil',       3, 5),
  (2, 'kathai-sollum-kutties',  'கதை சொல்லும் குட்டீஸ்',  'Little Storytellers', 5, 8),
  (3, 'thirukkural-thiramai',   'திருக்குறள் திறமை',      'Thirukkural Talent',  6, 12),
  (4, 'kutti-pesalar',          'குட்டிப் பேச்சாளர்',     'Little Speaker',      8, 12),
  (5, 'tamil-kalaikoodam',      'தமிழ் கலைக்கூடம்',       'Tamil Art Studio',    5, 12),
  (6, 'tamilil-sollu',          'தமிழில் சொல்லு!',        'Say It in Tamil',     6, 12);

-- ---------------------------------------------------------------------------
-- event_settings: one row. Registration stays closed until an admin sets the window
-- and the consent version, and results stay hidden until an admin sets a publish time.
-- ---------------------------------------------------------------------------
create table public.event_settings (
  id                       boolean primary key default true check (id),
  submissions_open_at      timestamptz,
  submissions_close_at     timestamptz,
  current_consent_version  text check (current_consent_version ~ '^[A-Za-z0-9._-]{1,40}$'),
  results_publish_at       timestamptz,
  updated_at               timestamptz not null default now(),
  constraint settings_window check (
    submissions_open_at is null or submissions_close_at is null or submissions_close_at > submissions_open_at
  ),
  -- winners are announced on 14 Nov 2026 (IST); nothing may be scheduled earlier
  constraint settings_results_floor check (
    results_publish_at is null or results_publish_at >= timestamptz '2026-11-14 00:00:00+05:30'
  )
);

insert into public.event_settings (id) values (true);

-- ---------------------------------------------------------------------------
-- user_roles: administrators and judges only. Parents are simply authenticated users
-- with no row here. Roles are never read from user-editable JWT metadata.
-- ---------------------------------------------------------------------------
create table public.user_roles (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  role        text not null check (role in ('admin', 'judge')),
  granted_by  uuid references auth.users (id) on delete set null,
  granted_at  timestamptz not null default now(),
  unique (user_id, role)
);

-- judge_profiles: exists only for users holding the judge role (composite foreign key).
create table public.judge_profiles (
  user_id       uuid primary key,
  role          text not null default 'judge' check (role = 'judge'),
  display_name  text not null check (length(btrim(display_name)) between 1 and 80),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  foreign key (user_id, role) references public.user_roles (user_id, role) on delete cascade
);

-- ---------------------------------------------------------------------------
-- submissions: one row per child registration and its video. Holds the only PII.
-- ---------------------------------------------------------------------------
create table public.submissions (
  id              uuid primary key default gen_random_uuid(),
  -- anonymous id shown to judges; unrelated to any personal data
  entry_code      text not null unique default (
    'RIO-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5)) ||
    '-'    || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5))
  ),
  owner_id        uuid not null default auth.uid() references auth.users (id) on delete restrict,
  event_id        smallint not null references public.events (id),

  child_name      text not null check (length(btrim(child_name)) between 1 and 80),
  child_age       smallint not null check (child_age between 3 and 12),
  age_as_of       date not null default date '2026-11-14' check (age_as_of = date '2026-11-14'),

  parent_name     text not null check (length(btrim(parent_name)) between 1 and 80),
  parent_email    text not null check (
    parent_email = lower(parent_email) and length(parent_email) <= 254
    and parent_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  -- as entered; must be a 10-digit Indian mobile, optionally prefixed with 91 or 0
  parent_mobile   text not null check (
    regexp_replace(parent_mobile, '[^0-9]', '', 'g') ~ '^(91|0)?[6-9][0-9]{9}$'
  ),

  -- duplicate deterrence keys: last 10 digits of the mobile, and the child name with
  -- case, spaces and common punctuation removed (Unicode NFC)
  parent_phone_norm text generated always as (
    right(regexp_replace(parent_mobile, '[^0-9]', '', 'g'), 10)
  ) stored,
  child_name_norm   text generated always as (
    regexp_replace(lower(normalize(child_name, NFC)), '[[:space:].,''’‘`´_-]+', '', 'g')
  ) stored,

  consent_version text not null,
  consent_at      timestamptz not null default now(),

  -- opaque reference to the private video object; never a URL (storage arrives in M4)
  video_key       uuid unique,

  status          text not null default 'draft' check (status in ('draft', 'uploaded', 'finalized', 'withdrawn')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  finalized_at    timestamptz,
  withdrawn_at    timestamptz,

  constraint submissions_name_norm_not_empty check (length(child_name_norm) > 0),
  constraint submissions_video_matches_status check (
    (status = 'draft' and video_key is null) or
    (status in ('uploaded', 'finalized') and video_key is not null) or
    status = 'withdrawn'
  ),
  constraint submissions_finalized_stamp check ((status = 'finalized') = (finalized_at is not null) or status = 'withdrawn')
);

create index submissions_owner_idx on public.submissions (owner_id);
create index submissions_event_status_idx on public.submissions (event_id, status);

-- one finalized submission per child, across all six competitions
create unique index submissions_one_finalized_per_child
  on public.submissions (parent_phone_norm, child_name_norm)
  where status = 'finalized';

-- ---------------------------------------------------------------------------
-- judging
-- ---------------------------------------------------------------------------
create table public.judge_assignments (
  judge_id       uuid not null references public.judge_profiles (user_id) on delete cascade,
  submission_id  uuid not null references public.submissions (id) on delete cascade,
  assigned_by    uuid references auth.users (id) on delete set null,
  assigned_at    timestamptz not null default now(),
  primary key (judge_id, submission_id)
);

-- One independent row per judge per submission. The 0-100 mark is a placeholder until the
-- rubric (decision D8) is fixed; a per-criterion breakdown can be added in M6.
create table public.scores (
  id             uuid primary key default gen_random_uuid(),
  judge_id       uuid not null default auth.uid() references public.judge_profiles (user_id) on delete restrict,
  submission_id  uuid not null references public.submissions (id) on delete restrict,
  marks          numeric(5, 2) check (marks between 0 and 100),
  comments       text check (length(comments) <= 2000),
  status         text not null default 'draft' check (status in ('draft', 'final')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  finalized_at   timestamptz,
  unique (judge_id, submission_id),
  constraint scores_final_needs_marks check (status <> 'final' or marks is not null),
  constraint scores_final_stamp check ((status = 'final') = (finalized_at is not null))
);

-- ---------------------------------------------------------------------------
-- winners: a row exists only because an administrator approved it. Publication is a
-- separate explicit step (event_settings.results_publish_at).
-- display_name is typed by the admin (for example a first name); it is never copied
-- automatically from the submission.
-- ---------------------------------------------------------------------------
create table public.winners (
  id             uuid primary key default gen_random_uuid(),
  event_id       smallint not null references public.events (id),
  submission_id  uuid not null unique references public.submissions (id) on delete restrict,
  rank           smallint not null check (rank between 1 and 10),
  award_label    text check (length(award_label) <= 80),
  display_name   text not null check (length(btrim(display_name)) between 1 and 60),
  approved_by    uuid not null default auth.uid() references auth.users (id),
  approved_at    timestamptz not null default now(),
  unique (event_id, rank)
);

-- ---------------------------------------------------------------------------
-- audit_log: written only by triggers; readable by admins. Never stores PII.
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       uuid,
  action      text not null,
  table_name  text not null,
  row_id      text,
  details     jsonb not null default '{}'::jsonb
);
create index audit_log_at_idx on public.audit_log (at desc);

-- indexes for foreign keys used in joins (the primary/unique keys above lead with judge_id)
create index judge_assignments_submission_idx on public.judge_assignments (submission_id);
create index scores_submission_idx on public.scores (submission_id);
