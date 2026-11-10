-- Local development seed only. Runs on `supabase db reset` against the LOCAL database.
-- It is not applied by `supabase db push`, and it contains no personal data.

-- Open registration locally so the M3 forms can be tried. Production values are set by an administrator.
update public.event_settings
set submissions_open_at     = now() - interval '1 day',
    submissions_close_at    = now() + interval '30 days',
    current_consent_version = 'dev-local';
