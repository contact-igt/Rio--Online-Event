# Release checklist: Rio Children's Day 2026

Status 2026-11-06 (announcement date 14 November 2026 IST, eight days away): **the MVP is built and has passed one complete journey on the
DEV project. Nothing is deployed and no production resource exists. NOT READY for production.** This file names settings and steps; it never
contains a value. Evidence for every claim: `PROJECT_BRIEF.md` §27 to §33.

## 1. Completed functionality

"DEV-live" = exercised once against the real DEV Supabase project and the real DEV R2 bucket (journey, brief §32). "Offline" = automated tests only.

| Area | State | Evidence |
|---|---|---|
| Landing page, `/competitions` (age filter 3 to 12), competition details, registration, success, administrator and judge screens in the approved pink and navy design; mobile first; no poster | built (final redesign) | offline: browser checks at 360, 390, 768 and 1440 px, AA contrast measured on every text |
| Parent email-code sign-in | built | DEV-live |
| Child registration, draft saving, consent record | built; registration closed until an administrator sets a window | DEV-live |
| Private video upload (direct to R2 with a 15-minute signed URL) | built; switch `RIO_UPLOADS_ENABLED` | DEV-live (Chrome-made MP4 and WebM) |
| Participation confirmation e-mail (outbox, retry endpoint, bilingual template with competition, reference and announcement date; no link, no video) | built; **sending OFF** (`RIO_EMAIL_ENABLED`), needs migration 00800 and a configured and tested provider | offline with mocks and real Postgres; **never sent a real e-mail** |
| Final submission: ownership, consent, window, HeadObject re-check (size, type, ETag), header-level inspection, atomic locked state, duplicate-child protection | built; switch `RIO_FINALIZE_ENABLED` | DEV-live |
| Staff sign-in at `/staff/login` (email and password through Supabase Auth; the role is then checked in the database; sign-out; no registration, no reset page) | built (staff-login change) | offline: unit, database-role and browser tests; **not yet run against DEV** (no staff account exists there) |
| Administrator area: competitions, entries by status, judge assignment, judges' progress, ranking, winner confirmation | built | DEV-live |
| Judge area: only assigned entries, no child or parent data, private playback (5-minute link, audited), draft and final score | built; switch `RIO_PLAYBACK_ENABLED` | DEV-live |
| Ranking: average of final marks, only complete entries, ties flagged and never resolved | built | offline, DEV-live (no tie) |
| Public winners page `/results`: shows nothing until publication is scheduled **and** its time has passed; never cached; never publishes | built (M7) | offline; the built server answered "to be announced" on DEV |
| Audit log of role, assignment, score, winner, status changes and every playback link | built | DEV-live |
| Publication of results (scheduling the time) | **no screen**: done by SQL (section 6, step 10) | n/a |
| Staff accounts | **no screen**: provisioned explicitly (section 6, step 5); there is no public staff registration | n/a |

Last test results: 606 unit and database tests on Postgres 17 and 18, 131 browser tests, build (before M7); M7 additions: results unit 9, results database 7,
static guards, results browser 6 (contrast and 360 px measured), 30 browser tests re-run after the footer change, one production build. The journey and
fixture suites were not repeated.

## 2. Environment variables

Set in Vercel **Production** scope only. Nothing here exists in any production environment yet (all are "missing"). Values are never written in this repo.

| Name | Secret | Needed at build | Rule |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | no | **yes** (inlined into the build) | the PRODUCTION project |
| `RIO_SUPABASE_ALLOWED_REF` | no | no | the production project ref; the app refuses any other project |
| `SUPABASE_SECRET_KEY` | **yes** | no | service-role key; server code only (upload, finalization, playback) |
| `R2_ACCOUNT_ID` | no | **yes** (the Content-Security-Policy is built from it) | production account |
| `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | **yes** (key, secret) | no | the PRODUCTION bucket and a token scoped to it |
| `RIO_OTP_LENGTH` | no | no | equal to the OTP length set in Supabase Auth (6 to 10; default 6) |
| `RIO_UPLOADS_ENABLED`, `RIO_FINALIZE_ENABLED`, `RIO_PLAYBACK_ENABLED` | no | **yes** (the policy names the bucket host only when uploads or playback are on) | `no` unless set to exactly `yes`; **changing one needs a redeploy, not only a settings change** |
| `RIO_EMAIL_ENABLED` | no | no | `no` unless exactly `yes`. Confirmation e-mails are sent only with this AND the three settings below; until then the intention is only recorded in the outbox |
| `EMAIL_PROVIDER` | no | no | `resend` (the only provider implemented; choose the provider with the client) |
| `EMAIL_API_KEY` | **yes** | no | the provider's key with sending permission only; read in one file only (`lib/email/config.ts`) |
| `EMAIL_FROM` | no | no | a sender on a domain verified with the provider (SPF, DKIM, DMARC), for example `Rio Hospital <noreply@your-domain>` |
| `EMAIL_REPLY_TO` | no | no | optional |
| `CRON_SECRET` | **yes** | no | at least 32 random characters; the scheduler sends it as `Authorization: Bearer ...` to `/api/email-sweep`, which retries failed e-mails (404 for everyone else) |
| `RIO_STAFF_INVITES_ENABLED` | no | no | `no` unless exactly `yes`. Judge invitations from `/admin/judges`. While off, the form is disabled with a visible warning and no Supabase Auth call is made. Turn it on only after Supabase Authentication has working custom SMTP, the invitation template is pasted in and a test invitation was received. Also needs `SUPABASE_SECRET_KEY` (server-only) |

Never set in Vercel: `RIO_DIST_DIR`, `RIO_DEV_PROJECT_REF`, `RIO_CONFIRM_PUSH`, `RIO_LIVE_*`, `SUPABASE_DB_PASSWORD`, `SUPABASE_DEV_POOLER_URL`
(tooling and tests only). Preview deployments must have no production secrets (point them at DEV or give them none). Check R2 settings without printing
them: `npm run r2:check`.

## 3. Production resources needed

| Resource | Needed | Notes |
|---|---|---|
| Supabase production project | create | separate from DEV; backups and point-in-time recovery on; region chosen with the client (data residency); only schema `public` exposed to the Data API |
| Supabase Auth | configure | email provider on, other providers off; OTP length and expiry fixed; site URL = production domain; project rate limits on; **custom SMTP** (see below) |
| Email delivery | create | Two separate uses of e-mail: (1) Supabase Auth sign-in codes, which need custom SMTP (the built-in sender allows only a handful per hour: not usable for launch) and the template `supabase/templates/otp-code.html`; (2) the app's confirmation e-mail through the provider API above. A domain with SPF, DKIM and DMARC serves both; the same provider can do both |
| Scheduler | create | a Vercel Cron (or any scheduler) calling `GET /api/email-sweep` with the bearer secret every 5 to 10 minutes once e-mail is enabled; add the cron entry to `vercel.json` at that time (not present now) |
| Supabase Auth: staff invitations | configure | Authentication > Email Templates > Invite user: paste `supabase/templates/invite-judge.html` (the link opens `/staff/set-password` with a one-time token, so the judge chooses a password; no password is ever e-mailed). Authentication > URL Configuration > Site URL: the website address. Custom SMTP must be working (the built-in sender allows only a few e-mails per hour). Password rules (length, strength) are set in Authentication > Providers > Email |
| Cloudflare R2 production bucket | create | **private**: no custom domain, `r2.dev` off. Token scoped to this bucket only. CORS: `PUT` from the production origin only (no wildcard), header `Content-Type`, expose `ETag`. Lifecycle: delete `pending/` objects after 1 day. No other public access |
| Vercel project | create | paid plan (the free plan is not for commercial use); region near Supabase; deployment protection on previews; function duration long enough for final submission (it reads up to 14 small ranges from R2) |
| Domain and HTTPS | client to supply | Vercel issues the certificate; the app already sends HSTS and `upgrade-insecure-requests` |
| Monitoring | create | the app **logs nothing by design** (no personal data in logs). Needs: Vercel runtime-error alerts and a log drain, Supabase log and advisor review, an uptime check on `/`, `/signin` and `/results`, a weekly audit-log review |
| Staff | client to name | administrators and judges (emails), judge confidentiality agreement |

**Video retention and deletion (missing, required before real children's data):** the cleanup script (`npm run uploads:cleanup`) deletes only replaced,
rejected and abandoned uploads; it never touches an attached video. A **withdrawn or taken-down entry leaves its video in R2**, and there is no deletion
tool. Needed: the client's retention period (for example delete all videos N days after the announcement), a written takedown and parent-erasure
procedure, and a small reviewed script or runbook that deletes the exact `videos/<id>` of a withdrawn entry and marks the upload deleted.

## 4. Client approvals and decisions required (none has been given; none is assumed)

| # | Decision | Effect while open |
|---|---|---|
| D5 | Consent wording approved by legal advisers, and a privacy notice and terms page (none exists in the app) | The only wording is `v0-provisional`; the screen says it is provisional. **Nothing in the code stops an administrator opening registration with it.** Approved text goes in as a NEW version (for example `v1`) in `lib/registration/consent.ts`, then a redeploy, then the administrator sets that version |
| D8 | Judging rubric, weights, judges per entry, tie rule | One 0 to 100 mark; ties are only flagged and the administrator decides. No rule has been invented |
| D9 | Registration window, upload deadline, judging period, publication time | Registration stays closed until set |
| D13 | Native-speaker review of all Tamil text | Tamil is provisional everywhere; staff screens are English with Tamil headings |
| D1 | Approved logo and assets | text placeholder in the header |
| New | Whether a child's first name may be published when the parent did **not** give the optional permission | The winners page shows the typed display name to everyone. The administrator screen now shows the permission (Yes or No) and warns; it does not block |
| New | Domain name, data region, video retention period, who the administrators and judges are, who approves publication | needed to configure production |

## 5. Critical risks and blockers

Blocker = do not launch until resolved or explicitly accepted in writing by the owner.

| # | Item | Class |
|---|---|---|
| B1 | **Rate limiting is in memory per server instance.** On Vercel each instance counts separately, so the limits on sign-in, registration, upload, submission, playback and scoring do not hold under real traffic or abuse. Supabase's own Auth limits remain. Fix before public launch: Vercel firewall rate-limit rules on `/signin`, `/events/*/register` and the action endpoints, and/or a shared store (database table or Redis) behind `lib/auth/rate-limit.ts` | **Blocker** |
| B2 | D5 and D8 undecided (section 4); no privacy notice | **Blocker** |
| B3 | No production project, migrations, bucket, SMTP, domain or deployment. The guarded migration tooling refuses production by design, so a reviewed production procedure (section 6, step 3) must be agreed | **Blocker** |
| B4 | **No real phone videos tested.** Only Chrome-made MP4 and WebM exist as fixtures. Not tested: iPhone MOV (usually HEVC), Android camera MP4, MOV with the index at the end, a 90 s / 100 MB file on a mobile network (single upload, no resume). A judge on a desktop browser without HEVC support may be unable to play an iPhone video | **Blocker** (run on real devices) |
| B5 | Header-level inspection only. It checks the container, a video track and the declared duration; it does **not** prove the frames decode, that a header is honest, or the length of a browser-recorded WebM (no duration) | Accepted limitation, to be stated to the client |
| B6 | Production email delivery not configured or tested | **Blocker** |
| B7 | No video deletion or takedown tool; retention undecided | Should-fix before real data |
| B8 | No server-side error logging or alerting | Should-fix |
| B9 | Publication and staff accounts by SQL only | Accepted with the runbook below |
| B10 | The accessibility and keyboard checklist (axe, keyboard-only pass, reduced motion) has been run for the browser components, not for the staff and results pages as pages; contrast and 360 px were measured for the results page | Should-fix |
| B11 | Eight days remain to the announcement: registration, uploads, judging and approval all have to fit | Schedule risk |
| B12 | Switches are fixed at build time: enabling one needs a redeploy | Operational note |
| B13 | Confirmation e-mail has never been sent for real: provider not chosen, domain not verified, migration 00800 not applied, no scheduler. Everything is tested with mocks only. The app promises an e-mail nowhere while it is off | **Blocker for the confirmation e-mail only** (leave `RIO_EMAIL_ENABLED=no` and the launch can proceed without it) |
| B14 | The logo used everywhere is the supplied `rio logo v2.png` (giraffe, in the approved mock-ups 03 to 06). Mock-up 01 and 02 show a different lotus logo that was not supplied, and no hero photograph or illustrations were supplied: the owner must provide approved files if wanted | Should-fix |
| B15 | Judge invitations have never been sent for real: no hosted account was created, SMTP and the invitation template are not configured or tested, and `RIO_STAFF_INVITES_ENABLED` is `no`. Existing judges are unaffected | **Blocker for inviting judges from the screen only** (the two provisioned DEV accounts keep working) |

## 6. Deployment steps (each needs the owner's explicit approval; do not run any of them without it)

1. Resolve the blockers B1 to B3 and B6 or accept them in writing. Record the approvals in `PROJECT_BRIEF.md`.
2. Create the production Supabase project; enable backups; set Auth (section 3); configure SMTP and DNS; send yourself a test email.
3. Apply migrations `20261105000100` to `20261105000700`, in order, to **production only after** the same files are confirmed unchanged by their hashes
   (00100 `fe3e2851f8343d46`, 00200 `224b5d0ce4801714`, 00300 `b36e4314f56dd4f9`, 00400 `8c995be9d66de368`, 00500 `321659c194f2f25d`,
   00600 `539ae80ea433ea86`, 00700 `dbedd1f8efabaf09`, each a prefix of its SHA-256). Use a reviewed, approved procedure (the guarded tool is DEV-only).
   Migration `20261105000800` (the confirmation e-mail outbox, hash prefix `1d52fdcc7890f69a`) is **prepared and not applied anywhere**: apply it after 00700 only
   when the owner approves enabling the confirmation e-mail. Until then the app records nothing, and a submission is never affected.
   Verify as was done on DEV: history, six events, registration closed (all settings null), function owners and EXECUTE rights, RLS on every table.
4. Create the production R2 bucket, token, CORS and lifecycle rule (section 3). Run `npm run r2:check` with the production values.
5. Create staff. Staff sign in at `/staff/login` with an email and a password; accounts are created only by a project owner, never by the app.
   - **DEV (script):** `RIO_LIVE_CONFIRM=<dev ref> RIO_CONFIRM_PROVISION=<dev ref> npm run staff:provision -- --role admin --email <email>` or
     `... --role judge --email <email> --name "<display name>"`. It asks for the password twice at a hidden prompt (or reads `RIO_STAFF_PASSWORD` set for
     that one command), passes it only to Supabase Auth, prints nothing secret, refuses the production project, and is safe to repeat. `--reset-password`
     sets a new password for an existing account. A password must be 12 to 128 characters, not contain the email name, not be a common password.
   - **Production (by hand, no script):** Supabase dashboard, Authentication, Users, "Add user": the email, a password typed there, "Auto confirm user" on. Then in
     the SQL editor (no password anywhere in SQL):
     `insert into public.user_roles (user_id, role) select id, 'admin' from auth.users where email = '<email>';`
     and for a judge `... 'judge' ...` followed by
     `insert into public.judge_profiles (user_id, display_name) select id, '<name>' from auth.users where email = '<email>';`
   - A person with no role, a parent, and a judge whose profile is `active = false` are refused at `/staff/login` even with a correct password.
     Deactivate a judge with `update public.judge_profiles set active = false where user_id = (select id from auth.users where email = '<email>');`
   - Staff can also still sign in with an e-mailed code at `/signin` (same account, same role check); that cannot be switched off without changing the parent flow.
   - Passwords are handled by Supabase Auth only. Choose a strong password per person, share it by a channel the hospital trusts, and have each person keep it private.
     Set the Supabase password rules (minimum length, leaked-password protection if the plan allows) on the production project.
6. Create the Vercel project, domain and Production environment variables (section 2) with **all three switches `no`** and the production R2 account id present.
   Deploy.
7. Run the post-deployment verification (section 7) with the switches still off.
8. Rehearse on a non-production pair (a second Supabase project and bucket) with real phone videos and an administrator and judge account (blocker B4).
9. Approved text and window: add the approved consent version, redeploy, then an administrator sets `current_consent_version` and the window in `event_settings`.
10. Enable features in order, each followed by a redeploy and a check: `RIO_UPLOADS_ENABLED=yes`, then `RIO_FINALIZE_ENABLED=yes`, then (when judging starts) `RIO_PLAYBACK_ENABLED=yes`.
11. Publication, only on the owner's instruction and not before 14 November 2026 IST: confirm winners in the administrator area, review the sharing-permission column,
    then a project owner runs `update public.event_settings set results_publish_at = '<approved time with +05:30>';`. The database refuses any earlier date. To withdraw
    a result, delete the winner in the administrator area (it disappears from `/results` at once).

## 7. Post-deployment verification (read-only unless stated)

- `/` loads over HTTPS; `/results` answers "The winners announcement date will be confirmed later" (until the client approves a date in `lib/events.ts`) and its response has `Cache-Control: no-store`.
- Response headers: HSTS, `X-Frame-Options: DENY`, and a Content-Security-Policy that does **not** name the bucket host while uploads and playback are off.
- Registration page shows "closed" before the window; a direct database insert as a parent is refused (`submissions_closed`).
- `/admin` and `/judge` send a signed-out visitor to `/staff/login`; a signed-in parent gets 404; `/staff/login` shows the form, is not indexed, and offers no registration; a wrong password gives the generic message (after the staff account exists).
- Sign-in email arrives from the production sender with a code of the configured length (staff address only).
- R2: the bucket has no public URL; an unsigned request for any object returns 403; `r2.dev` is off; CORS names only the production origin.
- Catalog: the four judging/finalization functions are SECURITY DEFINER with an empty search path and no EXECUTE for PUBLIC, anon or authenticated (except `assign_judge_to_event` for authenticated); the old `finalize_submission` is absent; function body fingerprints equal the repository's (`npm run db:dev:inspect judging_function_acls` shape).
- Supabase advisors show no security errors; every public table has RLS.
- After switches are on, with approval: one rehearsal (the journey test pattern) against the non-production pair, never against live children's data.

## 8. Go / no-go checklist

All must be "Met" for GO. Today's status is the right-hand column.

| # | Condition | Status |
|---|---|---|
| 1 | Legal-approved consent wording and privacy notice live (D5) | **Not met** |
| 2 | Rubric and tie rule decided, or the owner accepts the placeholder (D8) | **Not met** |
| 3 | Dates and window decided (D9); publication time approved | **Not met** |
| 4 | Tamil copy reviewed, or the owner accepts it as provisional (D13) | **Not met** |
| 5 | Production Supabase, R2, Vercel, domain and SMTP created and configured | **Not met** |
| 6 | Migrations 00100 to 00700 applied to production and verified | **Not met** (DEV: Met) |
| 7 | Rate limiting suitable for public use (B1) | **Not met** |
| 8 | Uploads verified on real phone formats and a mobile network (B4) | **Not met** |
| 9 | Email OTP delivery verified end to end on the production sender (B6) | **Not met** |
| 10 | Complete journey passes on a non-production pair with the production-like build | Met on DEV (one run) |
| 11 | Video retention and takedown procedure agreed and runnable (B7) | **Not met** |
| 12 | Administrators and judges named and created; confidentiality agreed | **Not met** |
| 13 | Monitoring and alerts in place (B8) | **Not met** |
| 14 | Results remain private until publication (tested) | Met |
| 15 | Video storage private; unsigned and tampered requests refused (tested) | Met on DEV |
| 16 | The owner has accepted header-level inspection (B5) in writing | **Not met** |
| 17 | All three switches `no` until their step in section 6 | Met |
| 18 | Confirmation e-mail: provider chosen, domain verified, 00800 applied, a real test e-mail received, scheduler set; or the owner accepts launching without it | **Not met** (e-mail stays `no`) |
| 19 | The owner approves the new look of the public pages (pink and indigo palette, logo file) | **Not met** |
| 20 | Judge invitations: SMTP and the invitation template configured, one real invitation received and a password set, then `RIO_STAFF_INVITES_ENABLED=yes`; or the owner accepts creating judges by the provisioning script | **Not met** (invitations stay `no`) |

**Decision today: NO-GO / NOT READY for production deployment.**
