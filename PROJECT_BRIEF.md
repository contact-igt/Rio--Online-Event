# PROJECT BRIEF — Rio Hospital Children's Day 2026

> Source of truth. If code, prompts or chat disagree with this file, this file wins until it is edited.
> Rules for how to work live in `CLAUDE.md`. Update **§11 Status** at the end of every module.

| | |
|---|---|
| Event | மழலைத் தமிழே! — என் மொழி… என் மகிழ்ச்சி! (Children's Day Celebration 2026) |
| Client | Rio Hospital for Women & Children (reference: https://www.riochildrenshospital.com/) |
| Target launch | **2026-11-05** (see §9, Risk R1: this date is today) |
| Winner announcement | **2026-11-14** |
| Repo | `https://github.com/contact-igt/Rio--Online-Event.git` (empty, no commits) |
| Brief version | Admin, judge and registration management built and tested offline (§37); final UI/UX redesign (§36); landing refinement and confirmation e-mail (§35) — 2026-11-07 |

---

## 1. Requirements

### 1.1 Facts taken from the poster (`rio event.jpg`, not yet in repo)
Six online video competitions, ages 3–12. **Age bands overlap**, so category choice matters.

| # | Tamil name | English gloss | Ages | Task |
|---|---|---|---|---|
| 1 | மழலை மொழி | Toddler Tamil | 3–5 | Sing a Tamil rhyme / say favourite Tamil words |
| 2 | கதை சொல்லும் குட்டீஸ் | Storytelling kids | 5–8 | Tell a short story in Tamil |
| 3 | திருக்குறள் திறமை | Thirukkural talent | 6–12 | Recite a Thirukkural and explain its meaning |
| 4 | குட்டிப் பேச்சாளர் | Little speaker | 8–12 | 1-minute speech, title "தமிழ் என் அடையாளம்" |
| 5 | தமிழ் கலைக்கூடம் | Tamil art studio | 5–12 | Craft/art using Tamil letters |
| 6 | தமிழில் சொல்லு! | Say it in Tamil | 6–12 | Give the correct Tamil word for English words |

Poster rules: video 30–90 seconds · clear audio and video · **parent's submission only** · mode: online (video) · exciting prizes **and e-certificate for all participants**.
Poster award categories (6, mapping to competitions **not stated**): Best Little Speaker, Best Story Teller, Best Tamil Scholar, Creative Star, Tamil Star, Best Little Artist.

### 1.2 Functional requirements
- **FR1** Parent registers a child: child name, age, parent name, email, mobile number, plus explicit parental consent.
- **FR2** Parent picks one eligible category for the child (age must fall inside the category's band).
- **FR3** Parent uploads one video per child. Upload goes browser → private storage, never through the app server.
- **FR4** Parent can replace the video until they **finalize**. Finalizing is irreversible for the parent and locks the entry.
- **FR5** One finalized entry per child across all six competitions (enforced in the database, not just the UI).
- **FR6** Admin sees all registrations and entries, can search, export, and handle takedown/withdrawal requests.
- **FR7** Judges see only entries assigned to them, stream the private video, and submit scores. Judges do not see parent contact details.
- **FR8** Admin reviews computed rankings and **approves winners by hand**. Nothing is published automatically.
- **FR9** Public results page shows approved winners only, and only after publish time on or after 2026-11-14.
- **FR10** Site is bilingual (Tamil first, English second) and usable on a mid-range Android phone on mobile data.
- **FR11 (decision pending)** E-certificate for every finalized participant (poster promise).

### 1.3 Non-functional requirements
- **NFR1** Private by default: no public video URLs, ever. Videos are reachable only through short-lived signed URLs minted after a role check.
- **NFR2** Child data minimised: collect only the five fields above plus consent. No child photo, school, address or date of birth (age in years only).
- **NFR3** Accessibility: WCAG 2.2 AA; Tamil text renders correctly; 44px touch targets.
- **NFR4** Performance (mobile, 4G throttled): LCP ≤ 2.5s on landing page; upload resumable after a dropped connection.
- **NFR5** Every state change on an entry, score or winner is written to an audit log.

---

## 2. Architecture

```
Parent / Judge / Admin browser
   │  HTTPS (Vercel)                         ┌───────────────────────────┐
   ├──► Next.js App Router (TS) ───────────► │ Supabase Postgres + Auth  │  RLS on every table
   │       server actions / route handlers   │ (region: Mumbai, ap-south-1) │
   │            │ mint presigned URLs only   └───────────────────────────┘
   │            ▼
   └──► Cloudflare R2 (PRIVATE bucket)  ◄── browser uploads directly (multipart presigned PUT)
                                            judges stream via presigned GET, TTL ≤ 5 min, logged
```

### 2.1 Decisions
| ID | Decision | Why |
|---|---|---|
| A1 | Next.js (current stable, App Router) + TypeScript `strict` | Proposed stack; one deployable unit |
| A2 | Tailwind CSS with Rio design tokens as CSS variables | Tokens in one file; no component library by default (add shadcn/ui primitives only when a module needs one) |
| A3 | Supabase Postgres + Auth; **Row Level Security enabled and tested on every table** | Authorization lives in the data layer, not only in route code |
| A4 | Roles (`parent`, `judge`, `admin`) in a `user_roles` table, **never** in user-editable metadata | Prevents self-promotion |
| A5 | Parent sign-in by email one-time code (no passwords stored). Mobile OTP only if an SMS provider is approved (D6) | Less credential risk for a one-off event |
| A6 | Admin and judge accounts are invited by admin only, with MFA required for admin | Small, known user set |
| A7 | R2 bucket private, no public domain, CORS limited to the site origin | NFR1 |
| A8 | Upload: server action validates (auth, ownership, entry state, declared size/type) → returns presigned multipart URLs → browser uploads → server verifies object size/type via `HEAD` before marking `uploaded` | Vercel request-body limits make proxying videos impossible and unsafe |
| A9 | DB invariant: partial unique index on `entries(child_id) WHERE status = 'finalized'` | FR5 survives bugs and races |
| A10 | Judges see an anonymous `entry_code`, category and video only | Reduces bias; protects contact data |
| A11 | Winners: `winner_proposals` (computed) → admin approval row → `results_published_at`. Public read policy requires an approval row **and** `now() ≥ publish_at` | FR8, FR9 |
| A12 | Secrets only in Vercel/Supabase env settings and local `.env.local` (git-ignored). Service-role key and R2 secret are server-only | Never exposed to browser |
| A13 | No analytics, ad pixels or third-party trackers on any page a child or parent uses | Child data protection |
| A14 | Fonts self-hosted via `next/font` | No third-party request carrying visitor IPs |

### 2.2 Planned data model (finalized in M2)
`profiles`, `user_roles`, `children` (parent_id, name, age), `categories` (min_age, max_age), `consents` (parent_id, text_version, accepted_at), `entries` (child_id, category_id, status: draft|uploaded|finalized|withdrawn, entry_code, r2_key, size, duration), `judge_assignments`, `scores`, `winner_proposals`, `winner_approvals`, `audit_log`.

---

## 3. Module plan (Brain → Hands → Audit per module)

Each module: **Brain** writes the scoped prompt and acceptance tests → **Hands** implements only that scope → **Audit** runs the automated checks and a fresh-context review, then updates §11. No module starts before the previous one passes.

| Module | Scope | Depends on |
|---|---|---|
| **M0** | Brief, CLAUDE.md, repo inspection (this document) | — |
| **M1** | Scaffold, tooling, design tokens, security headers, bilingual landing shell | M0, D1–D3 |
| **M2** | Supabase schema, migrations, RLS, roles, seed categories, RLS test suite | M1, Supabase project |
| **M3** | Parent sign-in, consent, child registration, category selection | M2 |
| **M4** | Private video upload (R2 multipart), replace, finalize, one-per-child | M3, R2 bucket |
| **M5** | Admin console: registrations, entries, export, withdrawal/takedown, judge invites | M3 |
| **M6** | Judge portal: assignments, signed playback, scoring | M4, M5, D8 rubric |
| **M7** | Ranking, winner approval, results publishing, (optional) e-certificates | M6, D9 |
| **M8** | Hardening: accessibility pass, load test, pen-test checklist, backup/restore test, launch runbook | all |

Compressed launch path (R1): public launch needs **M1–M4**. M5–M7 must be live before the submission window closes. M8 runs in parallel with M5–M7.

---

## 4. Acceptance criteria and security boundaries per module

"Pass" means every line is verified by a command or test output, not by inspection alone.

### M1 — Scaffold and design shell
**Acceptance**
- `pnpm install && pnpm build` exits 0; `pnpm lint`, `pnpm typecheck`, `pnpm test` exit 0.
- Landing page renders Tamil and English text with no tofu/missing glyphs at 360px and 1440px (screenshot evidence).
- No horizontal scroll at 360px (measured `scrollWidth ≤ innerWidth`).
- Measured contrast for every text/background pair in use ≥ 4.5:1 (≥ 3:1 for large text and UI borders).
- Lighthouse mobile: Accessibility ≥ 95, Best Practices ≥ 95, LCP ≤ 2.5s.
- Response headers include CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS (verified with `curl -I`).
- `.env.example` lists variable names only; `.gitignore` excludes `.env*` (except example).
**Security boundary:** no database, no auth, no storage, no secrets. No third-party scripts. No real child data.

### M2 — Database and RLS
**Acceptance**
- Migrations apply cleanly to an empty Supabase project and are reversible in a dev branch.
- RLS enabled on 100% of `public` tables (query on `pg_tables.rowsecurity` returns no `false`).
- Automated tests prove, as each role: parent A cannot read/write parent B's children or entries; judge cannot read parent contact fields; anonymous reads nothing; only admin changes roles; second finalized entry for one child is rejected by the database.
- Seed contains the six categories with the age bands in §1.1.
**Security boundary:** service-role key never used in client code; only dev/staging project touched, never production data.

### M3 — Registration
**Acceptance**
- Parent can sign in by email code, accept consent (version recorded), add a child, and choose a category; ineligible age/category combinations are rejected server-side (test with ages 2, 3, 5, 12, 13).
- Server-side validation (zod) for all five fields; mobile number accepts valid Indian numbers only (format rule fixed in D7).
- Sign-in and registration endpoints are rate-limited (verified: 11th request in a minute is refused).
- Axe accessibility scan reports 0 serious/critical issues on every screen.
**Security boundary:** no passwords stored; error messages do not reveal whether an email is registered; PII never written to logs.

### M4 — Video upload
**Acceptance**
- 100 MB test video uploads end to end on throttled 4G; killing the connection mid-upload and resuming completes without restarting from zero.
- Rejected with a clear message: wrong type, over the size cap (D4), zero bytes, another parent's entry, finalized entry.
- Bucket check: unauthenticated `GET` of the object key returns 403/404; bucket has no public domain.
- Finalize locks the entry; a second finalize attempt for the same child (via UI or direct API call) fails.
- Orphaned partial uploads are aborted by a lifecycle rule (verified in R2 settings).
**Security boundary:** presigned URLs expire ≤ 15 min for upload; object keys are random (UUID), contain no child name; browser never receives R2 credentials.

### M5 — Admin console
**Acceptance**
- Only `admin` role with MFA reaches `/admin/*` (parent/judge/anonymous get 403 in tests).
- List, search and CSV export of registrations; export contains parent contact data and is itself audit-logged.
- Withdrawal/takedown sets entry `withdrawn` and revokes playback; the R2 object deletion is a separate, explicit, confirmed admin action.
- Every admin write appears in `audit_log` with actor and timestamp.
**Security boundary:** admin routes are server-checked, not hidden in UI; no bulk-delete.

### M6 — Judging
**Acceptance**
- Judge sees only assigned entries by `entry_code`; direct request for an unassigned entry returns 403 (test).
- Playback URL TTL ≤ 5 minutes; each issuance logged with judge id and entry id.
- Scores validated against the rubric (D8); a submitted score is immutable unless admin unlocks (logged).
- No parent name, email or mobile appears in any judge-facing response (checked by response-body test).
**Security boundary:** videos never downloadable from the UI (no download link; honest limit: a determined judge can still screen-record, so judges accept a confidentiality agreement, D8).

### M7 — Winners and results
**Acceptance**
- Ranking is reproducible: same scores produce the same order; ties are flagged, not auto-resolved.
- Public results endpoint returns nothing until an admin approval row exists **and** publish time has passed (tests with time mocked to before/after 2026-11-14).
- Only approved winners' first name/age band/category appear publicly (D10 decides exact fields).
- Publishing and un-publishing are admin-only and audit-logged.
**Security boundary:** no automatic winner selection or publication; humans decide.

### M8 — Hardening and launch
**Acceptance**
- Load test: 500 concurrent landing-page users and 50 concurrent upload sessions with p95 API latency < 800 ms and no errors.
- Dependency audit (`pnpm audit`) shows no high/critical issues, or each is documented.
- RLS and role test suite green in CI; a restore from backup to a scratch project verified once.
- Runbook covers: launch, incident, takedown request, key rotation, post-event data deletion/retention (D5).
- `/code-review` and `/security-review` findings all resolved or accepted in writing.
**Security boundary:** no deploy without explicit approval from the project owner.

---

## 5. Model recommendation

| Phase | Recommended model | Used for |
|---|---|---|
| Brain | Fable 5.1 or Opus 5.5 | Module prompts, schema/RLS design, threat modelling (M2, M4, M6, M7 especially) |
| Hands | Sonnet 5.5 | Implementation of a scoped module |
| Audit | Opus 5.5 in a **fresh session** (not the one that wrote the code) + automated checks | Review, security pass; the author should not be sole reviewer |
| Trivial edits | Haiku 5.5 | Copy tweaks, renames |

Principle: models propose, automated checks verify, humans decide judging and winners.

---

## 6. Design direction (summary; full rules in `CLAUDE.md`)
No design system or brand guide exists in the repo. A working one was **derived from the poster** and must be confirmed (D2). Warm, bright, trustworthy; Tamil-first typography; navy as brand, one yellow accent.

---

## 7. Assets inspection (M0 finding, updated in M1)

| Asset | In repo? | Found elsewhere | Action |
|---|---|---|---|
| Event poster | **Yes (M1)** at `public/images/rio-children-day-poster.jpg` | Copied byte-for-byte from `C:\Users\navee\Downloads\rio event.jpg` (574 KB). `public/images/` did not exist when M1 started | Done. Treated the M1 instruction to use it from `public/images/` as the D3 approval |
| Rio Hospital logo (vector/PNG) | **No** | Only appears inside the poster (blue wordmark). Website serves `/assets/shared/riologov2.png`. No standalone logo file exists on this machine | **Still a blocker for pixel-correct branding.** Header uses a plain text placeholder marked `TODO(D1)` in `components/site-header.tsx`. Owner must supply the approved logo file |
| Logo inconsistency | — | Poster logo = blue "Rio" wordmark. Building signage photo (`Downloads\rio1.png`) = maroon "Rio" with giraffe mark. | Owner decides which is the event logo (D1) |
| Illustrated child characters, scroll banner | No | Poster only | Not extractable cleanly; request source art if wanted |

Nothing was invented or recreated. Logo and illustrations are **not** to be redrawn.

---

## 8. Assumptions (unresolved until owner confirms)

| ID | Assumption | If wrong |
|---|---|---|
| S1 | "One finalized entry per child" means the child picks **one** category total | Constraint in A9 changes |
| S2 | Age is entered as whole years and checked against category bands as of entry date | Need DOB or cut-off date (D11) |
| S3 | Siblings are allowed under one parent account (multiple children) | Simplifies if single child |
| S4 | The six poster award names are separate from the six competitions | Scoring/winner model changes (D9) |
| S5 | Tamil is the primary UI language; English secondary | Content and font work changes |
| S6 | Event is India-only; Indian mobile numbers; DPDP Act 2023 applies | Compliance scope changes |
| S7 | "Ponytail" and "Taste-Skill" were not provided as files; I applied their commonly described principles (minimal code; design variance/motion/density dials). No third-party code installed | Supply the source to align exactly |
| S8 | **npm** is the package manager (M1 instruction; replaces the earlier pnpm assumption). Node 24.18, npm 11.16 | Switch back to pnpm |
| S9 | English event names are plain glosses and English task lines are my translations of the poster's Tamil. Tamil UI labels not on the poster (for example "விதிகள்", "பதிவு விரைவில் தொடங்கும்", rule lines) are also mine | Native Tamil speaker and the hospital must review before launch (D13) |
| S10 | The poster prints "கைவிளைப் பொருள்" in event 5; I used "கைவினைப் பொருள்" (handicraft) as the probable intended word | Revert one string in `lib/events.ts` if the poster wording is intended |
| S11 | "One competition entry per child" is shown publicly (home rules, event pages) based on S1, although the poster does not say it | Remove the line in `app/page.tsx` and `app/events/[slug]/page.tsx` if S1 is wrong |
| S12 | The "five planned tables" are events, submissions, judge roles/profiles, scores and event settings. Supporting tables were added where a requirement needs them: `user_roles`, `judge_assignments` (judges see only assigned entries), `winners` (admin approval) and `audit_log` | Drop or merge in a new migration before it reaches any hosted database |
| S13 | A judge gives one 0–100 mark plus comments per entry. This is a placeholder until the rubric (D8) is decided | Replace `scores.marks` with per-criterion columns in M6 |
| S14 | Mobile rule from D7 is applied in the database: 10-digit Indian mobile starting 6–9, optionally prefixed 91 or 0 | Edit one CHECK constraint |
| S15 | Administrator and judge accounts cannot register children | Remove `not private.is_staff()` from one RLS policy |

---

## 9. Risks and blockers

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| **R1** | **Target launch (2026-11-05) is today and no code exists.** Winners are due 2026-11-14, leaving about 9 days for registration, upload, judging and approval. | **High** | Fix the submission deadline now (D9). Follow the compressed path in §3. Consider a one-day-later soft launch rather than shipping unverified upload/RLS code |
| R2 | Children's personal data and videos. DPDP Act 2023 requires verifiable parental consent for under-18 data and bars tracking/targeted ads to children | High | Parent-only registration, minimal fields, consent record (versioned), no trackers (A13), legal review of consent/privacy text (D5) |
| R3 | Video as a leak vector (public URL, judge sharing) | High | NFR1, A7, A8, short TTL, access log, judge confidentiality agreement |
| R4 | Large uploads on weak mobile networks | Medium | Multipart + resume (M4), size cap (D4), plain-language guidance to record at 720p |
| R5 | Tamil rendering/typography defects | Medium | Self-hosted Tamil-capable fonts, visual checks at 360px in M1 |
| R6 | Spam/abuse registrations | Medium | Rate limits, email code, admin review; CAPTCHA only if abuse appears (adds friction/privacy cost) |
| R7 | Cloud costs (R2 storage, Vercel egress) | Low | R2 has no egress fees; estimate: 500 entries × ≤ 250 MB ≈ 125 GB |
| R8 | Single admin = single point of failure | Medium | At least two admin accounts with MFA |
| R9 | On this Windows machine an Application Control policy blocks Next's native SWC binary, so Turbopack cannot run. `dev` and `build` scripts therefore use `--webpack` (WASM compiler) | Low | Works and is verified. Drop `--webpack` if the policy is lifted or on Linux/Vercel; build is slower, not wrong |
| R10 | CSP allows `'unsafe-inline'` scripts because Next injects inline bootstrap code and pages are static | Medium | No third-party origins are allowed. Move to nonce-based CSP in M8 |
| R11 | Public page promises an e-certificate for all participants (poster wording) before D9 decides the scope | Low | Wording copied from the poster; confirm or soften in M7 |
| **R12** | **The hosted project in `.env` is the production `main` branch.** M2 has been applied only to the separate dev project `rio-childrens-day-dev`; production is untouched | **High** | The guard refuses the `.env` project for every command. Applying anything to production needs a separate explicit approval after dev is fully tested |
| R13 | Policy behaviour was verified through real Auth sessions on the DEV project only (25 of 25). Production has no M2 objects and no verification | Medium | Applying to production needs its own explicit approval, a dry-run, and a repeat of the structural and live checks against a production-safe target | 
| R14 | `judge_entries` and `published_winners` are security-definer views (intended). Supabase's advisor flags that pattern | Low | They list columns explicitly, filter on the caller, use `security_barrier`, and are covered by PII tests (also verified on the real DEV database and through live Auth sessions) |
| R15 | Next.js would have used the production Supabase project from `.env` (no `.env.local` existed) | High | Fixed in M3A: git-ignored `.env.local` points at DEV and the app fails closed unless `RIO_SUPABASE_ALLOWED_REF` names the configured project (§14.1). Hosted deployments must declare their own ref |
| R16 | Parent sign-in emails may carry a link instead of a code, or not be delivered, until hosted templates and custom SMTP are set | High | Owner action (§14.4); templates are prepared in `supabase/templates/otp-code.html` |
| R17 | ~~A real registration has not been saved to the dev database through the real form~~ **CLOSED in M3B.2E**: verified live (§15.13) | Closed | None |
| R19 | ~~Age dropdown reset after a validation error~~ **FIXED in M3B.2D and verified live in M3B.2E** | Closed | None |
| R18 | The consent wording (`v0-provisional`) is provisional and unreviewed by legal advisers; the screen says so | High | Do not open registration with it. Add the approved text as a new version, then have the administrator switch `event_settings` to it (D5) |

---

## 10. Required before implementation (credentials, files, decisions)

### 10.1 Needed for M1 (nothing secret)
- **D1** Approved Rio logo file(s) (SVG/PNG, light + dark backgrounds) and which logo variant to use.
- **D2** Confirm the poster-derived design system, or provide a brand guide.
- **D3** Confirm: poster is final art and may be copied into `public/` (or `design/`) in the repo.
- Confirm package manager (pnpm) and Vercel team/project name to be used later.

### 10.2 Needed later (secrets go to env settings, never into chat or git)
| Needed by | Item |
|---|---|
| M2 | Supabase **dev** project or branch only (never the production `main` branch). `.env` already holds the URL and publishable key. A secret/service key is not needed until M4 and must be added only to `.env.local` or Vercel settings |
| M3 | Email sender for one-time codes (Supabase SMTP or Resend/other) and a verified sending domain |
| M3 | **D6** SMS OTP provider for mobile numbers, or confirmation that email-only login is enough |
| M4 | Cloudflare account ID, R2 bucket name, R2 access key ID + secret (scoped to that bucket only) |
| M8 | Vercel project access, production domain (e.g., a hospital subdomain) and DNS access |

### 10.3 Decisions needed from the project owner
| ID | Decision |
|---|---|
| D4 | Video size cap and allowed formats (proposal: MP4/MOV/WebM, ≤ 250 MB, 30–90 s) |
| D5 | Retention and deletion of child data/videos after the event; consent and privacy policy wording (legal review) |
| D7 | Mobile number rule (proposal: 10-digit Indian mobile, +91) |
| D8 | Judging rubric and weights; number of judges per entry; judge confidentiality agreement |
| D9 | **Submission opening and closing dates**; whether the six awards map 1:1 to the six competitions; e-certificate scope |
| D10 | What is shown publicly for winners (proposal: first name, age band, category; no photo, no video unless guardian opts in separately) |
| D11 | ~~Age cut-off date~~ **Resolved in M2:** declared age as of 2026-11-14, enforced by a database constraint; no DOB collected |
| D12 | Names and emails of at least two admins and the judges |
| D13 | Native-speaker review of all Tamil text and English translations (S9, S10) |

---

## 11. Status

| Module | Status | Evidence |
|---|---|---|
| M0 | **Complete** (see M0 report) | This file and `CLAUDE.md` exist; repository inspected |
| M1 | **Complete, not committed** | See §12 |
| M2 | **Complete on the DEV project: applied, structurally verified and exercised through real Auth sessions (25 of 25 live tests, §13.14); production untouched** | See §12.3, §13.11, §13.14 |
| M2.1–M2.3 | **Readiness audit, guarded pooler workflow, approved dev apply: complete.** | See §13 |
| M2.4 | **Complete: 25 of 25 live Auth/RLS tests passed; cleanup verified; residue: 1 banned dummy admin + 97 audit rows in DEV** | See §13.13, §13.14 |
| M3A | **Built and tested locally (184 unit, 33 browser tests); app targets DEV only; real email delivery and real sign-in UNVERIFIED** | See §14 |
| M3B | **COMPLETE and verified live on DEV (§15.13): 7 of 7 live registration tests passed through the real app and real parent sessions; drafts persist, parents are isolated, the closed state holds, upload and final submission stay disabled. Consent wording is still provisional (D5) and registration stays closed on DEV** | See §15 |
| M4A | **COMPLETE and verified live on DEV (§26): the second controlled run passed 4 of 4 — a real parent uploaded a genuine 31 s WebM through the app to the private R2 bucket; HeadObject, the conditional copy, the database attachment, cross-parent isolation, expired/reused authorizations, the old-URL case and the closed-registration case all verified; cleanup verified clean. The server checks metadata only, never media. Uploads OFF (`RIO_UPLOADS_ENABLED=no`). M4B (finalize) built offline in §27** | See §17–§26 |
| M4B.1 | **Built and tested OFFLINE (§27): server-only final submission (service-role SQL functions + R2 HeadObject re-check), the old parent-callable finalizer removed, confirmation UI, 513 unit (PG17 and PG18) and 101 browser tests pass. Migration 00600 prepared, NOT applied. `RIO_FINALIZE_ENABLED=no`; **blocked from release by B1: no server-side media inspection**. Real database and bucket UNVERIFIED** | See §27 |
| M4B.2 | **Offline readiness done (§28.1–28.3):** stale live tests repaired (28 tests discovered, replayed offline, not run live), 00600 reviewed, 00700 added, bounded media inspection built. **Dry-run NOT run; nothing applied.** Safe to apply to DEV after dry-run and approval | See §28 |
| M5, M6 | **Built and tested OFFLINE (§28.4, §28.5):** admin and judge areas, private playback via 5-minute links (`RIO_PLAYBACK_ENABLED=no`), scoring, ranking with flagged ties, winner confirmation; 606 unit/database tests (PG17 and PG18), 131 browser tests, build pass; the whole journey passes on real migrations with a fake bucket. **Never run against real Supabase Auth or R2; not production-ready** | See §28, `DEPLOYMENT.md` |
| M7 | **Public winners page `/results` built and tested offline (§33); release checklist in `DEPLOYMENT.md`; go/no-go 4 of 17 met; NOT READY.** Publication screen, staff screens, certificates not built | See §33 |
| Staff login | **Built and tested offline (§34): `/staff/login`, role redirects, sign-out, DEV provisioning script; not run against DEV (no staff account yet)** | See §34 |
| M8 | Not started (hardening, rate limiting B1, accessibility audit) | — |
| Express migration M1 (2026-11-10) | **Backend foundation built and tested locally:** `backend/` (Express 5, TypeScript strict, zod-validated environment, `GET /api/v1/health`, request ids, security headers, body limit, redacting JSON logger, graceful shutdown, database adapter *interfaces* only). No database connection, tables, migrations, Auth or registration; Supabase and both Next apps untouched; nothing committed or deployed. The anonymous-registration, question-builder and `20261110001000` work reported earlier is **not in this repository** (searched all refs, reflog and local folders). | `DEPLOYMENT.md` section 0, `backend/.env.example` |
| Express migration M2A (2026-11-10) | **Database foundation built and tested locally:** `backend/src/db/` (adapter contract, MySQL pool and SQLite implementations over Kysely, sanitised errors, versioned migrations with SHA-256 checksums, `db:migrate/status/verify/reset:test`, environment guards). Tested on SQLite and on a disposable MySQL 8.0.46 container; CI job with a mandatory MySQL 8 service added but **not yet run on GitHub**. No application tables, no Supabase SQL ported, no Auth, `website/` and `admin/` untouched, nothing committed or deployed. | `DEPLOYMENT.md` section 0, `backend/.env.example`, `backend/migrations/README.md` |
| Express migration M2B (2026-11-10) | **Application schema built and tested locally, schema only:** ten paired MySQL and SQLite migrations (`backend/migrations/*/0001` to `0010`, 18 tables and the `published_winners` view), typed Kysely rows (`src/db/schema.ts`), `checkReadiness()` (`src/db/readiness.ts`, no route). Invariants enforced by constraints and triggers and proven on MySQL 8.0.46 and SQLite (447 backend tests with MySQL, 295 on SQLite alone). No Auth, no API route, no seed data, no Supabase code or data touched, `website/` and `admin/` untouched, nothing applied to any hosted database, nothing committed or deployed. Open business rules R1 to R13 and the transaction-level rules for M4/M5 are listed in `backend/migrations/README.md`. | §41, `backend/migrations/README.md` |
| Express migration M3 (2026-11-10) | **Staff authentication built and tested locally, backend only:** `POST /api/v1/staff/login`, `POST /logout`, `GET /me`, `POST /password` in `backend/src/auth/`; Argon2id (Node built-in), opaque HttpOnly cookie sessions checked in the database on every request, admin and judge authorization, forced first-login password change, database-backed shared login rate limits, Origin allow-list and CSRF header, audited login/logout/password changes, `staff:create-admin` and `staff:reset-password` commands. Tested on MySQL 8.0.46 and SQLite (642 backend tests with MySQL, 414 on SQLite alone) and by a smoke run of the compiled server. No website or admin file changed, no Supabase touched, nothing applied to a hosted database, nothing committed or deployed. Registration is still closed and no registration route exists. | §42 |
| Express migration M4 (2026-11-10) | **Anonymous registration built and tested locally, backend only:** `GET /events`, `GET /settings/public`, `POST /registrations`, `POST /registrations/recover`, `GET` and `PATCH /registrations/current` in `backend/src/registration/`; no OTP or parent account, recovery by a 120-bit code stored as SHA-256 (HttpOnly cookie or typed on another device), duplicate flagging for admin review (never blocking, never revealed), Tamil-safe NFC normalisation, +91 mobile normalisation, separate guardian and media consent, competition-specific questions bound to the published set, server-side window check, Origin/CSRF/CORS, shared database rate limits. Migration 0011 makes the guardian e-mail optional (SQLite rebuild via a new runner marker). Tested on MySQL 8.0.46 and SQLite (955 backend tests with MySQL, 607 on SQLite alone) and by a smoke run of the compiled server. No website or admin file changed, no Supabase touched, nothing applied to a hosted database, nothing committed or deployed. **Registration is still closed** (settings untouched, no data seeded). | §43 |
| Docker-free local development (2026-11-10) | **Partly done, blocked on database credentials:** Docker is not used; no Docker file ever existed in the repository (one documentation sentence replaced). MariaDB variants of the migrations, `DB_ENGINE`, `db:ready`, read-only `db:status` and `backend/LOCAL_DEVELOPMENT.md` are written and tested on SQLite; **nothing has run on the XAMPP MariaDB**, `rio_hospital` was not inspected or modified, no `.env.local` exists. | §44 |
| Local development finalisation (2026-11-10) | **Local database ready, tests on MariaDB blocked:** `rio_hospital` on the XAMPP MariaDB has all 11 migrations, the six competitions (`db:seed:events`) and closed registration; local origins configured; `.env.example` recreated; origin parser now refuses wildcard-looking hosts; `test:mariadb` runner built and BLOCKED for lack of a dedicated test account. Admin account not created (awaiting an approved e-mail). 728 backend tests pass on SQLite only; nothing verified by a MariaDB or MySQL 8 test run. | §45 |
| MariaDB security and frontend readiness (2026-11-10) | **Read-only inspection; MariaDB tests still BLOCKED.** MariaDB listens on all interfaces under live Public-profile firewall Allow rules, all root and pma accounts have no password, and the XAMPP data folder shows InnoDB/Aria inconsistencies (proposals only, nothing changed). The guide's test-account grant had lost its escape characters: fixed and now test-guarded. Neither Next app calls the Express API; recommended next module M5a (administrator API). | §46 |
| Local administrator sign-in via Express (2026-11-10) | **Done locally.** Admin sign-in, forced password change, `/admin`, refresh and sign-out run against the Express staff API; real-browser smoke test 20/20 on a throwaway database. Data screens show an explicit "not available yet" state. Nothing committed. | §47 |

---

## 12. M1 and M2 records, M3 definition

### 12.1 M1 result (2026-11-05): complete, nothing committed

**Built:** Next.js 16.4.5 (App Router) + TypeScript strict + Tailwind 4, scaffolded directly in this folder with npm (no nested app). `.gitignore` was written before `npm install`.
- Home page: bilingual hero with the poster, age finder (client component, no data stored), six competition cards with an age ruler, rules panel, prizes and awards, footer.
- `/events/[slug]`: six statically generated routes (`dynamicParams = false`), each with task, eligible-age ruler, shared-age links to the other competitions, previous/next, and an inactive "Registration opens soon" button.
- `lib/events.ts` is the single source for names, ages and tasks. Security headers in `next.config.ts`. CI workflow in `.github/workflows/ci.yml` (not run yet). No database, auth, storage, forms or uploads.

**Evidence (all run on this machine, 2026-11-05):**

| Check | Result |
|---|---|
| `npm install` | exit 0; 0 vulnerabilities in production deps; 8 moderate in dev tooling (`minimatch` via eslint; fix needs a breaking downgrade, left alone) |
| `npm run lint` / `npm run typecheck` | exit 0 / exit 0 |
| `npm test` (Vitest) | 9 of 9 pass: six events, poster age bands, Tamil script, overlaps, ages 2 and 13 rejected |
| `npm run build` (webpack) | exit 0; 9 static pages |
| `npm run test:e2e` (Playwright, installed Chrome) | 17 of 17 pass: six routes 200, unknown slug 404, age finder, headers, poster served, no horizontal scroll at 360px on all seven pages |
| Routes via `curl` | `/` and six event routes 200; `/events/nope` 404 |
| Assets | poster 200 `image/jpeg` 573,932 bytes (identical to source); optimized variant 200; every `<img>` loaded in browser |
| Headers | CSP, nosniff, Referrer-Policy, Permissions-Policy, HSTS, X-Frame-Options present; no `X-Powered-By` |
| Third parties | the only external URL in the HTML is a link to riochildrenshospital.com; no external scripts, fonts or images |
| Contrast (measured in browser, alpha-aware) | minimum 6.70:1 across 175 text elements on home and 56–58 on event pages, at 360, 768 and 1440 px; 0 failures |
| Layout | no horizontal overflow at 360, 768, 1440; smallest text 14px; interactive controls at least 44px (card links use a full-card hit area) |
| Fonts | Baloo Thambi 2 and Hind Madurai load; Tamil renders with no missing glyphs |
| Duplicate project | one `package.json` outside `node_modules`/`.next`; no nested app |
| M0 documents | `CLAUDE.md` SHA-256 identical to before M1; `PROJECT_BRIEF.md` changed only by this update |

**Defects found by measurement and fixed during M1:** (1) global heading colour overrode Tailwind utilities, making the "Rules at a glance" heading navy on navy (contrast 1.0); moved heading base styles into `@layer base`. (2) "Open full size" link was 20px tall; now 44px. (3) Back link wrapped badly at 360px; fixed.

**Not verified (do not claim):** Lighthouse scores and LCP (M1 §4 criteria, still open; run in M8 or on request), axe scan (M3 criterion), keyboard-only pass, `prefers-reduced-motion` behaviour (CSS written, not exercised), the GitHub Actions workflow (never executed), and Vercel build.

**Deviations from the plan, with reasons:**
- npm instead of pnpm: M1 instruction (S8).
- `dev` and `build` use `--webpack`: Windows Application Control blocks the native SWC binary (R9).
- Playwright smoke tests run on the installed Chrome (`channel: "chrome"`) to avoid a browser download.
- Display headings use line-height 1.35 instead of the 1.6 in `CLAUDE.md`; body stays 1.7. At 88px a 1.6 gap looks broken; checked in screenshots with no clipped glyphs. Consider amending `CLAUDE.md` to say this.
- Age finder added to the cards because poster age bands overlap; it filters nothing and stores nothing.
- Vitest config is `vitest.config.mts` (the `.ts` form printed a module-type warning).
- One early `vitest run` ran for over 5 minutes at high CPU and was killed; reruns finish in about 0.2 s. Cause not identified; watch for it in CI.

### 12.2 Open items from M1 (owner)
D1 logo file · D13 Tamil review · S10 poster wording · S11 public "one entry per child" line · confirm poster text matches the final approved poster.

### 12.3 M2 result (2026-11-05): built and tested locally; nothing applied to any hosted database

**Safety:** the hosted project is the production `main` branch. No `supabase link`, `db push`, `db reset`, migration, or any other call to it was made. The CLI reports `linked_project: null`. `.env` was read only to check names and value shapes; no value was printed or changed.

**Environment check (values not printed):** `.env` exists, is git-ignored (`.gitignore` line 19), and holds exactly two variables: `NEXT_PUBLIC_SUPABASE_URL` (a `*.supabase.co` project URL) and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_` prefix). No secret or service-role key is present, and none appears in `app/`, `components/` or `lib/`. `.env.example` now lists those two names (it said `ANON_KEY` before).

**Dependencies added:** `@supabase/supabase-js`, `@supabase/ssr` (not used until M3; no client code was written), `supabase` CLI 3.0.0 and `@electric-sql/pglite` (dev). `supabase/config.toml` came from `supabase init` run in a scratch folder, then edited (project id, `api.schemas = ["public"]`, local site URL, `auto_expose_new_tables = false`). The CLI parsed it; `supabase start` could not be tried (Docker, below).

**Files:** `supabase/config.toml`, `supabase/seed.sql` (local only), `supabase/migrations/20261105000100_core_schema.sql`, `…000200_functions_and_triggers.sql`, `…000300_rls_and_grants.sql`, `supabase/tests/{supabase-shim.sql,helpers.ts,migrations.test.ts,constraints.test.ts,access.test.ts}`; `vitest.config.mts` now also runs `supabase/tests`; `.gitignore` ignores `supabase/.temp`.

**Schema:** `events` (6 rows seeded from `lib/events.ts`; a test compares them), `event_settings` (one row; registration closed until an admin sets a window and consent version; results hidden until a publish time on or after 2026-11-14 IST), `user_roles` (admin/judge), `judge_profiles` (only for users holding the judge role), `submissions` (child, parent, consent version and server-set timestamp, opaque `video_key` uuid, status draft→uploaded→finalized→withdrawn, normalized duplicate keys, anonymous `entry_code`), `judge_assignments`, `scores` (unique judge+submission, draft/final), `winners`, `audit_log` (ids and states only).

**Database rules:** ages 3–12 and each competition's band; declared age as of 2026-11-14; one finalized submission per normalized mobile + child name (partial unique index, generic `duplicate_entry` error); status machine enforced by trigger (finalized rows locked, withdrawn is final); `video_key` and status are not writable by clients (status moves through `finalize_submission`/`withdraw_submission`; `video_key` only by trusted server code in M4); marks 0–100, final needs marks, final scores locked until an admin unlocks; last administrator cannot be removed.

**Security design:** RLS on every table; default Supabase grants revoked and only the listed grants re-added (a test snapshots every grant and fails on any change); `anon` reaches only `events`, `event_settings` and `published_winners`; role helpers live in an unexposed `private` schema and read `user_roles`, never JWT metadata; judges have no policy on `submissions`, so every direct query, join or count returns nothing, and see entries only through `judge_entries` (anonymous id, event, video reference, own marks); winners are public only through `published_winners` after an admin approves rows and schedules publication.

**Evidence (run on this machine):**

| Check | Result |
|---|---|
| Migration replay from empty (two fresh databases, identical catalog fingerprint) | **PASS** on PGlite 0.5.15 (Postgres 18) |
| Database tests: 74 (migrations 9, constraints 33, access 32) plus 9 existing data tests | **PASS** 83 of 83 |
| Anon, parent, judge, admin and role-less users | **PASS** (`access.test.ts`) |
| Judge cannot retrieve parent PII: direct query, filters, joins, counts, the safe view, every readable relation scanned for planted names/email/mobile, function errors, audit log | **PASS** |
| Duplicates, scores, roles, transitions, consent, window, age bands | **PASS** (`constraints.test.ts`) |
| Mutation check: five deliberate weakenings (judge read policy, PII column in judge view, staff registration, missing unique index, anon grant) | **PASS**: each made tests fail; originals restored (hashes match) |
| `npm run lint` / `typecheck` / `test` / `build` | exit 0 / 0 / 0 / 0 |
| `npm run test:e2e` | 17 of 17 pass |
| `npm audit --omit=dev` | 0 vulnerabilities |

**UNVERIFIED (do not treat as passed):**
- `supabase start`, `supabase db reset`, `supabase test db`: Docker Desktop would not start (no engine after 200 s).
- Behaviour on real Supabase: its `auth` schema, PostgREST role switching, Postgres 17 (tests ran on 18), and Supabase's own default privileges. The stand-in copies them, but it is a copy.
- Any hosted project (dev or production), the Supabase security advisor, and whether `supabase db push` accepts these files.

**Defects found while testing, fixed:** `published_winners` called a private function, which Postgres checks against the caller, so anonymous users could not read it; the condition is now inline. Linter rejected a helper named `useDb`; renamed `setupDb`.

**Needs your approval before anything touches Supabase:** (1) which dev project or branch to use (not production `main`), (2) `supabase link` to that target, (3) `supabase db push --dry-run` then the real push, (4) bootstrapping the first administrator by SQL as the project owner (no public route exists by design).

### 12.4 Open items (owner)
Carried from M1: D1 logo, D13 Tamil review, S10, S11. New: choose the dev target (R12); confirm D7 mobile rule; D8 rubric before M6; D5 consent wording before any real registration; D9 submission dates.

### 12.5 M3 definition (next module; do not start until approved)

**Title:** Parent sign-in, consent and child registration.
**Needs first:** owner approval to add parent sign-in (§13.7); migrations applied to a dev target after approval; email sender for sign-in codes; consent text and version (D5); submission window dates (D9).
**In scope:** email one-time-code sign-in with `@supabase/ssr` and the publishable key; consent screen that records the current version; registration form (child name, age, parent name, email, mobile, competition) writing through RLS; client and server validation (zod) matching the database rules; Tamil/English messages; rate limits; accessibility checks.
**Out of scope:** video upload, admin, judging, any use of a secret key in the browser, production data.
**Done when:** every M3 line in §4 has command output, a dev-target RLS test run passes, and `git status` shows only intended files.
**Model:** Brain = Fable 5.1 or Opus 5.5; Hands = Sonnet 5.5; Audit = fresh Opus 5.5 session.

---

## 13. M2.1 readiness audit (2026-11-05): nothing applied, nothing hosted written

**Scope kept:** no `db push`, `db reset`, `link` or remote migration; no commit or deploy; no credential printed. The only contact with the hosted project was one read-only anonymous probe (below).

### 13.1 Compatibility findings
| Area | Finding | Status |
|---|---|---|
| Postgres versions | The full suite (100 tests) passes on Postgres **17.5** and **18.6** (`npm test`, `npm run test:pg17`). `config.toml` pins 17. Nothing in the SQL needs more than Postgres 15 features (generated columns, `security_barrier`, `gen_random_uuid`, `normalize`) | PASS locally |
| Hosted Postgres version | Cannot be read without credentials. Check in the dev project: Dashboard > Settings > Infrastructure, or `select version();`. If it is not 17, edit `major_version` in `supabase/config.toml` | **UNVERIFIED** |
| Auth dependencies | Migrations need `auth.users(id)` (three foreign keys), `auth.uid()` (column default, policies, triggers, view) and roles `anon`, `authenticated`, `service_role`. All exist on hosted Supabase and the local stack. No extension is required (no `pgcrypto`) | Reviewed; real stack **UNVERIFIED** |
| CLI syntax (CLI 3.0.0, from `--help`) | The default target is **local**. A hosted target needs `--remote=<ref>`; a bare `--remote` means the linked project. `--dry-run` exists on `db push`. Hosted writes need `--yes`. Older docs that say `--linked` or `--db-url` do not match this CLI's help text | PASS (help text); real run **UNVERIFIED** |
| Default privileges | Hosted Supabase grants new `public` objects to anon/authenticated by default. Migration 3 revokes that for this project's objects and re-grants explicitly; the grant snapshot test fails on any drift | PASS locally |
| PostgREST | RPC functions take `{ "p_id": uuid }`; custom errors surface as HTTP 400 (`P0001`) or 409 (`23505`); `private` is not an exposed schema | Reviewed; live check prepared |
| Production state (anonymous, read-only probe) | `GET /rest/v1/events` returned `PGRST205` (table not found): **M2 has not reached the hosted project**. `Accept-Profile: private` returned `PGRST106` (schema not exposed). The root OpenAPI document returned 401 for the publishable key. Auth settings: email provider on, phone off, anonymous sign-in off, sign-up open, email confirmation required | PASS |

### 13.2 Security review
- **judge_entries cannot expose parent PII (PASS locally).** Judges have no policy on `submissions` (0 rows by any route). The view definition references only `id, entry_code, event_id, video_key, status` of submissions, and a static test fails if any `parent_*`, `child_*`, consent, owner, email, mobile or phone token appears. Behavioural tests scan every readable relation, error message and audit row for planted names, email and mobile. The real-Supabase repeat is prepared (§13.5).
- **Security-definer functions:** all 15 pin `search_path = ''`, are owned by the migration role, and none is executable by PUBLIC or anon (tests). The role helpers are the only private functions callable by `authenticated`.
- **Views:** `judge_entries` and `published_winners` are intentionally security-definer with `security_barrier`. Supabase's advisor will flag them (lint 0010). Accepted, because the alternative (granting judges table access) is worse. A function instead of a view is the fallback if the flag is unacceptable.
- **Auth abuse surface:** sign-up is open on the existing project, so anyone can obtain an `authenticated` session; that is intended for parents. They get only their own rows, and staff roles cannot be self-assigned (token metadata is ignored; tested). Spam registration needs rate limits and a CAPTCHA decision in M3.
- **GraphQL:** hosted projects expose `pg_graphql`. It shows only objects the caller can select, which for anon means `events`, `event_settings` and `published_winners`. Consider disabling the extension if unused.
- **Realtime:** no M2 table is in the `supabase_realtime` publication and none must be added (it would stream rows to subscribers).
- **Data deletion:** `submissions.owner_id` is `ON DELETE RESTRICT`, so deleting a parent in the Auth dashboard fails while entries exist. That is deliberate; the deletion runbook (D5) must delete entries first.

### 13.3 Migration corrections made in M2.1 (edited in place; the files had never been applied anywhere)
1. Migration 3 no longer revokes on `ALL TABLES IN SCHEMA public`; it revokes by name, so it cannot strip access from unrelated objects in a project that already has some. Its function loop covers only schema `private` objects owned by the running role, so it cannot fail on functions it does not own.
2. Policies use `(select auth.uid())` and `(select private.is_*())` (evaluated once per statement; advisor 0003), and the duplicate permissive SELECT policies on `submissions` and `scores` were merged (advisor 0006).
3. Added indexes on `judge_assignments(submission_id)` and `scores(submission_id)` (advisor 0001). Three audit-only columns (`granted_by`, `assigned_by`, `approved_by`) stay unindexed on purpose.
4. New tests lock these in: pinned search_path, view options, wrapped policy calls, one policy per role and action, the FK index list, a view definition free of PII tokens, the Postgres version, and recovery-script replay.
5. Config: `auto_expose_new_tables = false` (from M2). Side effect to remember: **later migrations must grant explicitly** for any new table or function.

### 13.4 Migration order, seeds, recovery
- **Order:** `20261105000100_core_schema`, `20261105000200_functions_and_triggers`, `20261105000300_rls_and_grants`. Timestamps are unique and increasing (tested). Replaying from empty gives an identical catalog (tested on both engines).
- **Seeds:** the six events live in migration 1 (needed in every environment) and a test compares them with `lib/events.ts`. `supabase/seed.sql` only opens a local registration window and is not run by `db push`.
- **Recovery (dev only):** `supabase/recovery/rollback_m2_dev_only.sql` removes every M2 object, restores Supabase's default privileges and clears the three history rows. A test applies it, checks nothing is left, and re-applies the migrations. **Production has no down-migration:** correct forward with a new migration, and confirm the project's backup/PITR plan before real entries exist. Whether the CLI wraps each migration file in a transaction is **UNVERIFIED**; if a push fails halfway on dev, run the recovery script and push again.

### 13.5 Development environment readiness
| Item | State |
|---|---|
| Separate dev project or branch | **None identified.** The CLI is not logged in (no access token), no Supabase connector exists in this session, and the only known project is the one in `.env`, which you described as the production `main` branch. **Owner action required.** |
| Docker / local stack | Docker Desktop will not start on this machine, so `supabase start` is unavailable. A local stack is the other valid live-test target |
| Guard | `scripts/db-dev.ts` refuses: no `RIO_DEV_PROJECT_REF`, a ref equal to the `.env` project, a CLI linked to another project, a bare `--remote`, and a `push` without `RIO_CONFIRM_PUSH` equal to the dev ref. All refusals were demonstrated offline; 9 unit tests |
| Live Auth-session tests | `supabase/live-tests/auth-sessions.live.test.ts` uses real sign-ins for anon, a role-less user, a user whose token metadata claims admin, two parents, two judges and two admins, through the real Data API. It typechecks and lints but **has never been run (UNVERIFIED)**. It refuses the production project and any hosted target without `RIO_LIVE_CONFIRM` |

**Proposed procedure.** Every step needs its stated approval; none has been run.
1. *Owner:* create a separate dev Supabase project (or a branch, if the plan supports branching) and confirm its Postgres major version. Put its values in `.env.live` (git-ignored; names in `.env.example`): `RIO_DEV_PROJECT_REF`, `RIO_LIVE_URL`, `RIO_LIVE_PUBLISHABLE_KEY`, `RIO_LIVE_SECRET_KEY`.
2. Check the dev database is empty: `select table_name from information_schema.tables where table_schema = 'public';` (migration 3 aborts if any public table lacks RLS).
3. `npm run db:dev:check` prints the masked target and the exact command, and runs nothing.
4. *Owner:* `npx supabase login` (a person, once), set `SUPABASE_DB_PASSWORD`, then `npm run db:dev:dry-run`, which runs `supabase db push --remote=<dev ref> --dry-run`. Expect exactly the three M2 migrations listed. **Stop and report.**
5. *After approval:* `RIO_CONFIRM_PUSH=<dev ref> npm run db:dev:push`.
6. *Owner,* in the dev SQL editor: create the first administrator with `insert into public.user_roles (user_id, role) values ('<auth user uuid>', 'admin');`. No public route exists, by design.
7. Run the dashboard Security and Performance advisors. Expected: security-definer-view on the two views (accepted) and unindexed foreign keys on the three audit columns (accepted). Anything else needs review.
8. `RIO_LIVE_CONFIRM=<dev ref> npm run test:live`. It creates and removes tagged test users and rows and restores the event settings. If the dev project had no other administrator, one test admin remains (the database refuses to delete the last administrator).
9. Never run `db reset`, `db push` or `link` against the production project.

### 13.6 Assumption review (age, mobile, scoring)
- **Age (OK; confirm with the hospital):** declared whole years as of 2026-11-14, enforced as a constant by a CHECK constraint (changing it needs a migration; D11 resolved). Bands overlap on purpose (§1.1). The declared age is not verified, and a child who turns 3 or 13 near the date is the parent's judgement.
- **Mobile (OK; D7 still open):** 10-digit Indian mobile starting 6–9 with an optional 91 or 0 prefix. It rejects overseas guardians and landlines. There is no OTP, so a typo goes unnoticed (an SMS provider is D6).
- **Duplicates (weak by design):** mobile plus normalized child name deters accidental and casual duplicates only. Transliteration ("Ravi" vs "ரவி"), a second family number, or a different spelling defeats it. Twins with the same name on one phone cannot both finalize, and an admin cannot override that without a migration or SQL.
- **Scoring (placeholder; D8):** one 0–100 mark with two decimals plus comments per judge per entry. There is no rubric, weighting, judges-per-entry rule, aggregation or tie-break. Ranking arrives in M7.

### 13.7 Does M3 need parent sign-in?
**Yes, under the M2 design.** Row-level security keys ownership to `auth.uid()`, and `status` and `video_key` are writable only through RPCs and trusted server code. Options: **(A) Supabase email one-time-code sign-in (recommended; matches what is built)**; (B) anonymous registration through server code using the secret key (breaks least privilege and needs a different ownership model); (C) mobile OTP by SMS (needs D6). The existing project already has the email provider on, sign-up open and email confirmation required. Supabase's built-in email sender is meant for testing and is tightly rate-limited, so launch needs a custom SMTP sender (verify the current limits in the dashboard). **Not introduced; needs your approval.**

### 13.8 Report status
| Check | Result |
|---|---|
| Migrations reviewed against real Supabase requirements | Reviewed; corrections applied (§13.3) |
| Local tests on Postgres 18.6 and 17.5 | **PASS** 100 of 100 on each |
| Mutation checks (8 deliberate weakenings) | **PASS**: all caught; originals restored (hashes match) |
| `npm run lint`, `typecheck`, `test`, `test:pg17`, `build`, `test:e2e` | exit 0 throughout; e2e 17 of 17; `npm audit --omit=dev` 0 vulnerabilities |
| Guard refusals (6 scenarios) | **PASS** offline |
| Hosted Postgres version | **UNVERIFIED** |
| Real Supabase replay, `supabase start`, advisors, `test:live`, `db push --dry-run` | **UNVERIFIED** (no target, no Docker) |
| Separate dev project | **Not available / not identified** |

### 13.9 M2.2 IPv4 Session Pooler connection (2026-11-05)

**Why:** the direct database host is IPv6-only and the development network has no IPv6, so `db:dev:dry-run` by project ref cannot connect.

**Method:** `SUPABASE_DEV_POOLER_URL` in the git-ignored `.env.live`. The CLI 3.0.0 accepts a database URL in `--remote=<url>` (its help lists `--remote[=<ref|branch|url>]`; `--password` is not used with a URL). `scripts/db-dev.ts` now starts the CLI directly with Node (no shell, so the URL is never re-parsed) and passes all CLI output through `redact()`.

**What the guard enforces for the URL:** scheme `postgresql://`; host `aws-N-<region>.pooler.supabase.com` only; port exactly **5432** (Transaction Pooler 6543, direct hosts, lookalike hosts and every other port refused); username exactly `postgres.<RIO_DEV_PROJECT_REF>` (a different or production project's username refused); database `/postgres`; no query string or fragment; password present. All earlier checks remain: dev ref must differ from the `.env` project, a linked CLI must be linked to the dev ref, a bare `--remote` is never used, and `push` needs `RIO_CONFIRM_PUSH`. Error messages are fixed strings that never echo input. The unit tests (126 in total, on Postgres 18 and 17) cover every refusal, assert that no credential, ref or host appears in any error, and check that redaction removes raw and percent-encoded passwords, the full URL and any other `postgres://` text.

**Known limit:** while the CLI runs, the URL is in its argument list and is visible to other processes of the same Windows user.

**Verification of the target (booleans only, nothing printed):** the dev project `rio-childrens-day-dev` is in the logged-in account, `ACTIVE_HEALTHY`, region `ap-southeast-1`. The pooler URL names that project, uses a host in the same region and port 5432. `RIO_DEV_PROJECT_REF` in `.env.live` has two characters transposed (positions 13 and 15), so the guard refused (exit 3). The production project is in a different region.

**Rotation gate:** the owner reported that a database password was exposed and must be rotated before any connection test. Rotation cannot be confirmed from this machine (the pooler URL's password differs from `SUPABASE_DB_PASSWORD` in the same file, which is only a hint), so no connection was attempted. `SUPABASE_DB_PASSWORD` is not used with a URL and can be deleted from `.env.live` after rotation.

**Status:** `npm run db:dev:check` refused (ref mismatch). `npm run db:dev:dry-run` **not run**. Pending migrations: not listed yet (expected: the three M2 migrations).

### 13.10 M2.3 pre-apply review (2026-11-05): awaiting approval, nothing written

- **Target verified:** `rio-childrens-day-dev`, `ACTIVE_HEALTHY`, `ap-southeast-1`, is in the logged-in account. The pooler URL names that project, uses a host in that region, port 5432 and database `postgres`. The CLI is not linked. The production project (`.env`) is a different project in a different region and is not the target.
- **Dry-run (read-only, redacted):** exit 0, `upToDate: false`, exactly the three local migrations, no seeds, no roles; target kind `db-url`. The captured output contains no password and no connection URL.
- **Local files match:** `20261105000100_core_schema`, `…000200_functions_and_triggers`, `…000300_rls_and_grants`; hashes identical to the M2.1 verified set.
- **Static review:** no DROP (one comment), TRUNCATE, DELETE, extension, role or system changes; nothing in `storage`, `realtime`, `cron`, `vault`. Creates 9 tables, 2 views, 16 functions, 13 triggers, 22 policies, 6 indexes (including one unique), 1 schema (`private`); alters only RLS on those 9 tables and default privileges for future `public` objects. The only references outside our schemas are the `auth.users` foreign keys and `auth.uid()`.
- **Residual risks:** the state of the dev `public` schema is unknown (a name clash would fail migration 1; migration 3 aborts if any other public table lacks RLS). Whether the CLI wraps each file in a transaction is unverified, so a mid-way failure could leave a partial schema; recovery would be the dev-only script and needs separate approval.
- **After approval (not yet done):** push, then verify tables, the six event rows, RLS flags and grants on the real database with `supabase db query` and `supabase db advisors` (both available in CLI 3.0.0 for remote targets), then the live Auth-session tests. The live tests still need `RIO_LIVE_URL`, `RIO_LIVE_PUBLISHABLE_KEY`, `RIO_LIVE_SECRET_KEY` and `RIO_LIVE_CONFIRM` in `.env.live`, which are not set.

### 13.11 M2.3 post-apply results (2026-11-05): migrations applied to DEV only

**Authorization and target:** the owner approved applying the three reviewed migrations to `rio-childrens-day-dev` (ref `rajbfcoxolnjgiqgvflm`) only. Before the push the ref was matched against `.env.live`, the project list of the logged-in account (name `rio-childrens-day-dev`, region `ap-southeast-1`, `ACTIVE_HEALTHY`), the pooler URL username and host region; it differs from the production project in `.env`; the CLI was not linked; the three file hashes were unchanged.

**Execution:** `npm run db:dev:push` ran once with `RIO_CONFIRM_PUSH` set for that single process only (never written to a file; verified unset in the shell and absent from `.env.live` afterwards). Exit 0. The CLI applied, in order, `20261105000100_core_schema.sql`, `…000200_functions_and_triggers.sql`, `…000300_rls_and_grants.sql`. Output was redacted and scanned: no password and no connection URL. No reset, rollback, retry or second push.

**Real database facts (read-only inspections through `npm run db:dev:inspect`, enforced by the CLI's `--read-only` flag; a fixed allowlist of queries, no arbitrary SQL):**
| Item | Result |
|---|---|
| Postgres | **17.11**, UTF8 (matches `config.toml`; resolves the "hosted version UNVERIFIED" item) |
| Migration history | the three versions, nothing else |
| Tables | 9 as expected; **RLS enabled on all 9**, none forced |
| Views | `judge_entries`, `published_winners`; `security_barrier` on, owner `postgres` |
| Policies | **22**, identical names to the migration files; all use `(select auth.uid())`/`(select private.is_*())`; at most one permissive policy per table, role and action |
| Triggers | **13**, all enabled (event_settings 2, judge_assignments 2, judge_profiles 1, scores 2, submissions 2, user_roles 2, winners 2) |
| Functions | **16** (3 public RPCs, 13 private), all security definer with empty `search_path`, owned by `postgres`; none executable by PUBLIC or anon; `authenticated` can execute exactly the 7 intended ones |
| Grants | the real grant snapshot (14 entries) is **identical** to the snapshot asserted by the local tests; anon reaches only `events`, `event_settings`, `published_winners`; `private` schema: anon no, authenticated yes |
| Seeds | **6 events**, identical to `lib/events.ts` (id, slug, Tamil and English names, age bands); 1 settings row, all null (registration closed, no consent version, no results time) |
| Data | all other tables empty (0 submissions, scores, assignments, profiles, roles, winners, audit rows); no test users created |
| Auth links | 5 foreign keys to `auth.users` created |
| Realtime | no M2 table in any publication |
| Extensions | none added by M2 (the project already has `pg_stat_statements`, `pgcrypto`, `uuid-ossp`, `supabase_vault`) |

My first analysis run reported 28 of 30 checks; both failures were bugs in the checking script, not in the database (the search_path setting prints with escaped quotes, and `pgcrypto` is a Supabase default). A targeted re-query confirmed 16 of 16 functions pinned and listed the extensions. All checks pass.

**Supabase advisors (`npm run db:dev:advisors`, read-only): 11 findings, 0 warnings.**
- ERROR, security: `security_definer_view` on `judge_entries` and `published_winners` (intended and accepted, §13.2).
- INFO, performance: 4 unindexed foreign keys. Three are the audit-only columns already accepted (`granted_by`, `assigned_by`, `approved_by`). **New:** `judge_profiles_user_id_role_fkey` (composite) has no covering index; negligible at this size and not caught by my tests, which only checked the first column. Add an index in a later migration if wanted.
- INFO, performance: 5 unused indexes (expected on empty tables).
- No finding for missing RLS, mutable function search_path, exposed `auth.users`, or extensions in `public`.

**Other observations:**
- Default privileges: for objects created by `postgres` in `public`, only `postgres` and `service_role` remain (our revoke worked). The platform's own `supabase_admin` default privileges in `public` still grant anon/authenticated on future objects created by that role. Our objects are created by `postgres`, so they are unaffected; do not create tables as `supabase_admin`.
- `storage` default privileges for `postgres` also grant anon/authenticated (platform default, irrelevant until Storage is used; uploads use R2).
- `pg_graphql` is installed on the platform; it exposes only what anon can select (events, settings, published winners).

**Not done (by instruction):** no test users, no live tests that write data, no policy behaviour test through real Auth sessions. `RIO_LIVE_URL`, `RIO_LIVE_PUBLISHABLE_KEY`, `RIO_LIVE_SECRET_KEY` and `RIO_LIVE_CONFIRM` are still absent from `.env.live`, so `npm run test:live` remains UNVERIFIED. The catalog-level checks above prove structure, grants and policies exist as designed; they do not execute the policies as signed-in users.

**Local verification after the push:** `npm run lint`, `typecheck`, `test` and `test:pg17` (131 of 131 on Postgres 18 and 17) and `build` all exit 0. New guard code: `npm run db:dev:inspect`, `npm run db:dev:advisors` (fixed read-only queries; every query re-checked as a single SELECT, run with `--read-only`; unit-tested).

### 13.12 M2.4 live Auth/RLS test preflight (2026-11-05): ready; not run; awaiting approval

**Nothing was executed against the database in this step.** No user, row or setting was created or changed. Only GET requests and read-only catalog queries touched the dev project.

**Configuration (names and shapes only):** `RIO_DEV_PROJECT_REF`, `SUPABASE_DEV_POOLER_URL`, `RIO_LIVE_URL`, `RIO_LIVE_PUBLISHABLE_KEY`, `RIO_LIVE_SECRET_KEY` present. `RIO_LIVE_CONFIRM` **missing on purpose**: it is the approval token, supplied inline when the run is approved. `RIO_CONFIRM_PUSH` absent. `.env.live` is git-ignored. The guard (`check-live`) now also requires: key kinds correct (publishable vs secret, by prefix or JWT role), the publishable key is not the production key, and `RIO_LIVE_URL`, `RIO_DEV_PROJECT_REF` and `RIO_LIVE_CONFIRM` all name the same non-production project. It currently refuses only because `RIO_LIVE_CONFIRM` is unset.

**Read-only readiness against the dev project:** the publishable key reads the 6 events and is refused on `submissions` (anon level, 401/`42501`); the secret key is accepted; `private` schema via the API returns 406. Baseline: events 6, event_settings 1 (all values null), every other table 0, audit_log 0, **0 auth users**. Auth: email provider on, phone off, anonymous off, sign-up open, email confirmation required (dummy users are created pre-confirmed through the admin API).

**Test design** (`supabase/live-tests/auth-sessions.live.test.ts`, rewritten in M2.4):
- Every permission assertion uses a real user JWT from `signInWithPassword` or the publishable key with no session. The secret key is confined to one setup/cleanup factory; a test decodes each user's token (role `authenticated`, correct `sub`) and checks the file references `target.secretKey` exactly once.
- Coverage of the requested cases: anonymous public events (plus settings and unpublished-winners view); unauthenticated submission access denied; parent sees only own entries; cross-parent reads **and** updates, deletes, withdraw and finalize denied (added); judges limited to assigned entries and the safe projection; judges get no PII from direct queries, counts, filters, resource embedding, RPC errors or any readable relation; unauthorized score changes denied (other judge, parent, admin, changing `judge_id`/`submission_id`, final scores locked, only an admin can unlock, marks outside 0–100); role escalation denied for parents, judges, role-less users and a user whose token metadata claims admin, including updating or deleting role rows; unpublished winners hidden from anon, parents, judges (also with a far-future publish time); publication before 14 Nov 2026 rejected with `23514`, and scheduling by non-admins refused; the six seeded events cannot be written by anyone, even an admin; audit log admin-only and immutable; deactivated judges lose access.
- Cases that were missing before M2.4 and are now covered: cross-parent update/delete, score tampering, role-row update/delete, winners hidden from signed-in non-admins, the pre-14-Nov rejection, events write protection, the JWT/secret-key confinement proof, baseline-and-restore verification.

**Data the run would create** (all tagged `m24<time><random>`, `@example.test`, random passwords never printed): 8 dummy auth users; 4 role rows and 2 judge profiles; 6 submissions (2 finalized fixtures, 1 draft and 1 registration made through the API, 1 finalized through the API, 1 uploaded duplicate); 1 assignment, 1 score, 1 winner. Temporary changes: registration window opened with consent version `live-test`; `results_publish_at` set to year 2099 then reset to null. Audit rows are written automatically (ids and states only).

**Cleanup scope:** only ids collected during the run (the dummy users and the submissions they own), in dependency order: winners, scores, assignments, submissions, judge profiles, judge/other roles, administrator roles, auth users; then settings are restored from the baseline snapshot. Afterwards the run compares table counts, the six events and the settings with the pre-run baseline and fails loudly on any difference. The six seeded events are never written (only read, and write attempts by users are expected to be refused).

**Known residue:** (1) `audit_log` rows remain (append-only by design). (2) The database refuses to delete the last administrator, and the dev project has no real administrator yet, so one dummy admin (role row and auth user) will remain, banned and with a random password; delete it after a real administrator exists. Creating the real administrator before the run avoids this residue.

**Security-definer view review (real database):** `judge_entries` and `published_winners` are owned by `postgres` (BYPASSRLS, not superuser, by design), `security_barrier` on, and granted only `SELECT`: `authenticated` on `judge_entries`; `anon` and `authenticated` on `published_winners`; nothing to PUBLIC. `judge_entries` filters on `private.is_judge()` and `a.judge_id = auth.uid()` (both false/NULL for anon and role-less users, so it fails closed), lists its columns explicitly (no `*`), reads five submission columns, and exposes `video_key` and `entry_code` only for finalized assigned entries. Resource embedding through PostgREST runs as the caller, so RLS on `submissions` still blocks it (covered by a live test). The helper functions are definer with an empty `search_path` and take no caller-supplied identifiers except `judge_can_score(uuid)`, which is not exposed through the API. `published_winners` shows only admin-typed display fields after an admin sets a reached publish time. **No authorization vulnerability found.** The Supabase advisor's two `security_definer_view` errors remain accepted.

**Local verification:** `npm run lint`, `typecheck` exit 0; `npm test` 134 of 134 (live tests excluded); build unchanged.

**Command that needs approval** (writes dummy users and rows to the DEV project and removes them):
`RIO_LIVE_CONFIRM=<dev ref> npm run test:live`

### 13.13 M2.4 live test run (2026-11-05): 23 of 25 passed; 2 test defects; no vulnerability found

**Authorization and guards:** the owner approved one run against `rio-childrens-day-dev` only. Before running: the approved ref matched `RIO_DEV_PROJECT_REF` and `RIO_LIVE_URL` and differed from the production project; `check-live` accepted only the dev target; production was refused both as the URL and as the confirmation; run ids are unique (`m24<time><random>`); cleanup lives in `afterAll` and is id-scoped; the baseline comparison explicitly allows the banned dummy admin and audit growth. `RIO_LIVE_CONFIRM` was set for that one process only and is absent from `.env.live` and the shell afterwards. `npm run test:live` ran **once** (47 s, exit 1). Output was captured, scanned (no key, URL or password) and scrubbed before display.

**Result:** 25 tests, **23 passed, 2 failed**. Both failures are defects in the test code, confirmed against the grant snapshot; neither is a database or RLS defect:
1. *"see only their own entries"*: the last assertion searched parentB's **own** rows for the shared dummy parent name, because every fixture used the same `parent_name`. The assertions that matter in that test (parentB gets no rows for parentA's entry by id; parentA's entry id not in parentB's list) passed. Fixed: parentB's fixtures now use a different parent name.
2. *"only an administrator can assign a role"*: the test supplied `granted_by`, which is deliberately not an insertable column (`insert-cols[role,user_id]`), so the insert was refused with `42501`. That is the secure behaviour. Fixed: the test now asserts the refusal, then inserts without `granted_by` and checks the stamp. The positive path (an administrator assigns a role and the user then sees it) therefore did **not** execute in this run.

**Verified on the real project (real Supabase Auth JWTs through PostgREST):** the harness proof (every user token has role `authenticated` and the right `sub`, anonymous has no session, the secret key is referenced once); anonymous can read the six events, settings and the unpublished-winners view and is refused (`42501`) on submissions, scores, assignments, profiles, roles, winners, audit log and `judge_entries`, cannot call RPCs, and cannot reach `private` (406) or private helpers (404); no one, including an administrator, can insert, update or delete events; role-less users and a user claiming admin in token metadata see nothing and cannot self-assign; parents can register (owner and draft set by the database), cannot set protected columns, stale consent is refused, staff cannot register; cross-parent update, delete, withdraw and finalize are denied and the owner's data is unchanged; parents can edit only their own drafts, finalized entries are locked, finalize works for the owner, and a duplicate child gets the generic `duplicate_entry` (`23505`); judges get zero rows from `submissions` by any route including counts, filters and embedding, see only their assigned entry through `judge_entries` with exactly the 10 safe columns, and no relation, error or RPC response contained the planted names, email or mobile; judges can score only assigned entries; other judges, parents and admins cannot read or change those marks; `judge_id`/`submission_id` cannot be changed; final scores are locked, only an administrator can unlock, and the judge can then edit and re-finalize; marks outside 0–100 are rejected; judges cannot manage assignments; deactivated judges lose access and are restored; role escalation by insert, update or delete is denied; admins can approve a winner with the approver stamped by the database, with event and status checks; winners stay hidden from anonymous, parents, judges and role-less users, also with a far-future publish time; publication before 14 Nov 2026 is rejected (`23514`) and scheduling by non-admins is refused; the audit log is admin-only, contains no personal data and cannot be edited or deleted.

**Cleanup and residual data (verified independently, read-only, after the run):**
| Item | Before | After |
|---|---|---|
| events | 6 | 6, hash identical to the pre-run snapshot |
| event_settings | 1 row, all null | 1 row, all null (restored) |
| user_roles | 0 | **1** (admin, expected residue) |
| judge_profiles, submissions, judge_assignments, scores, winners | 0 | 0 |
| auth users | 0 | **1**: dummy admin `m24…-admin1@example.test`, banned until 2126, random password unknown |
| audit_log | 0 | **47** append-only rows (user_roles 7, judge_profiles 6, event_settings 4, submissions 20, judge_assignments 2, scores 6, winners 2); no personal-looking text or run ids |

**Vulnerabilities found:** none.

**Next:** the corrected test file lints, typechecks and the unit suites pass (134), but it has **not** been re-run; a re-run needs a new approval. With the residual administrator present, a re-run can remove all of its own dummy administrators (the guard sees another administrator), so no further residue is expected. The residual dummy admin can be deleted once a real administrator exists.

### 13.14 M2.4 final live retest (2026-11-05): 25 of 25 passed; cleanup verified

**Authorization and guards:** the owner approved one additional run of the corrected suite against `rio-childrens-day-dev` only. Before running: the corrected lines were present in the test file, the guard unit tests (43), lint and typecheck passed, the migration hashes were unchanged, the approved ref matched `RIO_DEV_PROJECT_REF` and `RIO_LIVE_URL` and differed from production, `check-live` accepted only the dev target, and a production URL was refused (exit 3). `RIO_LIVE_CONFIRM` was set for that one process only and is absent from the shell and `.env.live` afterwards. `npm run test:live` ran once (66 s, exit 0). Output was captured, scanned (no key, URL or password) and scrubbed before display. No retry, reset, migration or policy change.

**Result: 25 of 25 passed.** Including the two tests that failed in the first run:
- *Parent isolation* ("see only their own entries"): passed, including the check that another parent's data never appears in a parent's own listing.
- *Administrator role assignment:* passed. An administrator's request that names a different `granted_by` is refused (`42501`; the column is not insertable). Without it, the administrator assigns the judge role, the database stamps the administrator as the grantor, the assigned user then sees exactly that role, and the administrator removes it. Unauthorized assignment (by parents, judges, role-less users and a user claiming admin in token metadata) is denied for insert, update and delete, in the same run.
- All 23 tests that passed in the first run passed again.

**Cleanup (verified independently, read-only, against the pre-run state):**
| Item | Before this run | After this run |
|---|---|---|
| events | 6 (hash `e056688e…`) | 6, identical hash |
| event_settings | 1 row, all null | 1 row, all null (restored) |
| user_roles | 1 (admin, residue of the first run) | 1, same |
| judge_profiles, submissions, judge_assignments, scores, winners | 0 | 0 |
| auth users | 1 (banned dummy admin, until 2126) | 1, same; all 8 users from this run were deleted |
| audit_log | 47 | **97** (+50 append-only rows: user_roles 17, judge_profiles 12, event_settings 8, submissions 40, judge_assignments 4, scores 12, winners 4); no personal-looking text |

This run left **no new residue**: the residual banned administrator from the first run counted as another administrator, so the database allowed both of this run's dummy administrators to be removed.

**Security findings:** none. No policy, grant, view or function was changed.

**Remaining dev residue:** one banned dummy administrator (auth user and role row), and 97 append-only audit rows. Delete the dummy administrator after a real administrator exists.

**Status:** M2 is complete on the dev project. Production has not been touched and nothing has been applied to it.

---

## 14. M3A parent email authentication (2026-11-05)

**Scope kept:** no child details, no upload, no admin, registration not opened publicly (no public page links to the sign-in flow; the event pages still show the inactive "Registration opens soon" button), no migrations or RLS changes (hashes unchanged), no hosted Auth settings changed, no production access, no real session faked, no commit or deploy.

### 14.1 Environment target (finding and fix)
**Finding:** before M3A, Next.js would have used the **production** Supabase project, because `.env` holds the production URL and key and no `.env.local` existed (verified with Next's own env loader, in development and production modes).
**Fix:** a git-ignored `.env.local` (created from the DEV values in `.env.live`, no secret keys; `.env` untouched) now overrides it, verified for both modes. The app also **fails closed**: `lib/supabase/config.ts` refuses to talk to any Supabase project unless `RIO_SUPABASE_ALLOWED_REF` names the project in `NEXT_PUBLIC_SUPABASE_URL`, rejects secret or service-level keys in the public variable, and its errors never echo values. A production `.env` with no declared ref therefore cannot be used by accident. Hosted deployment (Vercel) must declare its own allowed ref explicitly.

### 14.2 What was built
- **Routes:** `/signin` (email), `/signin/verify` (six-digit code), `/account` (protected: shows the signed-in email, sign-out), `/events/[slug]/register` (protected placeholder that proves the selected competition survives sign-in; collects nothing). The landing page and the six event pages remain static.
- **Flow:** the parent enters an email; a server action calls `signInWithOtp` (new parents are created by Supabase Auth, existing ones sign in; messages never reveal which). The address is kept in a 15-minute **httpOnly** cookie (not in the URL, not in JavaScript). The parent types the six digits; the server calls `verifyOtp(type "email")`, Supabase sets the session cookies, and the parent lands on the selected competition's registration page, or `/account` if none was selected.
- **Resend cooldown:** 60 seconds, enforced on the server (and by Supabase's own limit), with a live countdown and a disabled button on the page. **Invalid or expired codes:** one clear message ("wrong or expired, check or send a new code"); too many attempts gets its own message. **Loading states:** the buttons disable and change text while a request runs.
- **Selected event:** carried as a validated slug (only the six known slugs; any URL or other value is dropped), so there is no open redirect.
- **Session:** cookie-based via `@supabase/ssr`; `proxy.ts` (Next 16's name for middleware) refreshes tokens on the three session routes only; each protected page validates the session with the Auth server (`getUser`), so a forged or revoked cookie is not trusted. Sign-out ends this browser's session only. A returning parent who opens `/signin` is forwarded on.
- **Abuse limits (first layer):** in-memory, per server instance: 8 sends per IP, 5 per email, 8 code attempts per IP and email, per 10 minutes. Supabase enforces its own limits as well. No CAPTCHA yet.
- **Privacy:** nothing logs an email or a code (test asserts no console output); the browser never talks to Supabase (the CSP keeps `connect-src 'self'`; a browser test checks that only the app's own origin is contacted); the verify screen shows a masked address.
- **Copy:** Tamil first, English second, in `lib/auth/messages.ts`. The Tamil here is mine and needs the D13 review.
- **Email templates:** `supabase/templates/otp-code.html` (code only, bilingual) and entries in `supabase/config.toml` for the **local** stack; the CLI still parses the config. Nothing was pushed to the hosted project.
- **Deviation:** no browser Supabase client. The code is verified on the server, so no client component needs one, and the project rules forbid unused code. It is a one-file addition if M3B needs it.
- **Dependencies:** `zod` added (the project rule requires it for server-side validation).

### 14.3 Evidence (all run locally on 2026-11-05)
| Check | Result |
|---|---|
| `npm run lint`, `typecheck` | exit 0, exit 0 |
| `npm test` (Postgres 18) and `npm run test:pg17` | **184 of 184** on each (50 new auth tests: config guard, validation, redirects, cooldown, error mapping, limiter, actions, session and proxy) |
| `npm run build` | exit 0; static `/` and six event pages; dynamic `/signin`, `/signin/verify`, `/account`, `/events/[slug]/register`; proxy registered |
| `npm run test:e2e` | **33 of 33** (17 existing + 16 new) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Migration hashes, `CLAUDE.md`, production `.env` | unchanged |

**Covered by tests:** invalid email; invalid and wrong-length code; **invalid code against the real dev Auth server** (refused with the "wrong or expired" message, no session cookie created, still signed out; it sends no email and creates nothing); resend cooldown (server rule and the disabled button with a live countdown); session refresh and cookie writing (proxy test); protected routes redirect and keep the selected competition; unknown competition returns 404; sign-out (action test); no email or code in logs or returned state; mobile layout.
**UI measurements (360 px, built app):** minimum text contrast 6.17 (error state) and 6.7 (code screen), 6.77 (sign-in); inputs 48 and 56 px tall; no horizontal overflow; smallest text 14 px; no target under 44 px; Tamil renders without missing glyphs. Not run: axe scan, keyboard-only pass, reduced-motion check.

### 14.4 Real email delivery and real sign-in: UNVERIFIED
No real code has been emailed or typed. Reasons: no inbox access from here, and the hosted dev project's Auth configuration is the owner's to set. Likely blockers, in order:
1. **Email templates.** The hosted "Confirm signup" and "Magic link" templates must contain `{{ .Token }}`. Supabase's defaults send a link, which this screen cannot use. Paste `supabase/templates/otp-code.html` into both (Authentication > Email Templates).
2. **SMTP.** The built-in email service is meant for testing: it sends only to project team addresses and is tightly rate-limited. Parents need a custom SMTP sender before launch.
3. **Auth settings to confirm in the dashboard:** OTP length 6 and expiry (the screen does not state a duration because the hosted value is not known; consider 10 to 15 minutes), email provider on, sign-up allowed, rate limits, and the CAPTCHA decision.
A full sign-in test is prepared but **not run**: `npm run test:e2e:live` (`e2e-live/parent-auth.live.spec.ts`). It creates one dummy dev user with the secret key, obtains a real one-time code through the admin API (so no email is needed), types it into the real app, and checks landing on the selected competition, session persistence across reload and a second tab, the returning-parent redirect, sign-out, and that a used code fails. It needs approval because it writes to the dev Auth project, and one detail is unverified: whether a code from `generateLink` is accepted as `verifyOtp` type `email`.

### 14.5 Open items
Owner: update the templates and SMTP (14.4), confirm Auth settings, approve `test:e2e:live`, review the Tamil copy (D13), decide CAPTCHA. For M3B: consent text and version (D5), submission window dates (D9), the registration form, and wiring the public "Register" button (not done in M3A by design). The shared in-memory limiter should move to a shared store before launch if abuse appears.

---

## 15. M3B parent registration and consent (2026-11-05)

**Scope kept:** no video upload, no admin screens, no winner logic. Registration is **not** opened: the dev database has no submission window and no consent version, so both the page and the database refuse registrations. No public page links to the sign-in or registration routes. Nothing was written to any hosted database; no test records were created; no commit or deploy; production untouched. Migrations 1–3 and RLS are unchanged (hashes verified).

### 15.1 What was built
- **Page and action:** `app/events/[slug]/register` (protected by a verified parent session; the chosen competition is preserved through sign-in) and its server action `saveDraft`.
- **Form fields:** child name, child age (a list limited to the competition's band), parent or guardian name, **verified email shown read-only**, 10-digit Indian mobile. Nothing else is collected: no date of birth, no school, no address.
- **Verified email:** `parent_email` is taken from the signed-in session on the server; the form has no email field and any client-supplied value is ignored.
- **Ownership:** the action never reads or sends an owner id. The row's owner is filled by the database from the session (`auth.uid()`), and row level security alone decides what a parent can read or change. Reads use the parent's own session, so another parent's registration cannot be returned.
- **Validation:** names (letters and combining marks of any script, including Tamil; no digits; up to 80), age 3–12 **and** the competition's own band from `lib/events.ts` (the database trigger re-checks it), mobile (any common spelling becomes `+91` plus ten digits; the first digit must be 6–9). Hostile or odd input is a validation error, never a crash (a test found and fixed one case that threw).
- **Consent:** mandatory guardian consent (recorded as `consent_version` plus the server-set `consent_at`) and a **separate, optional** media consent. The version the parent agrees to is the one currently set in `event_settings`; if it changed while the form was open the parent must read and agree again. The app only accepts versions it has wording for, so nobody can agree to text the app cannot show. **The wording (`v0-provisional`) is provisional, says so on screen, and makes no claim of legal approval; it needs the hospital's review (decision D5).**
- **Several children, one finalized entry per child:** a parent can register many children and the same child in several competitions as drafts. The app blocks a second registration of the same child (same normalized name and mobile, the database's own rule) in the same competition, and blocks a child who already has a finalized entry elsewhere. The database enforces one finalized entry per child across all parents when finalizing in M4. A per-account cap of 10 registrations applies in the app only (a direct API call is not capped; a database cap would need another migration).
- **Edit and resume:** the parent's drafts for the competition are listed (mobile masked); opening one pre-fills the form and saves changes, without re-stamping consent. After saving, the parent returns to the saved draft with a clear **"Draft saved"** message, and a refresh reloads it from the database.
- **Failure handling:** expired session (back to sign-in with an explanation, nothing saved), validation errors per field, duplicate, closed registration, consent changed, limits, rate limit (20 saves per account per 10 minutes, in memory), and database failures mapped to safe messages that never show raw database text.
- **Video upload and final submission:** shown as genuinely disabled buttons, labelled "available in the next step". No handler or route exists behind them.
- **Registration closed:** until an administrator sets the window and consent version, the page shows "Registration has not opened yet" and no form. Nothing in the app can open registration.

### 15.2 New migration (prepared, NOT applied)
`supabase/migrations/20261105000400_media_consent.sql` adds one column, `submissions.media_consent boolean not null default false`, with insert and update grants to `authenticated`. It is additive: no existing column, policy, trigger or grant changes. The optional media consent had nowhere to live in the schema. The grant snapshot test, recovery script and three new behaviour tests cover it (85 database tests). **Guarded dry-run against the dev project: exactly this one migration is pending; it was not applied.** It must be applied to dev before registration is opened there; until then a registration that ticks media consent would fail with a generic "not saved" message.

### 15.3 Evidence (local, 2026-11-05)
| Check | Result |
|---|---|
| `npm run lint`, `typecheck` | exit 0, exit 0 |
| `npm test` and `npm run test:pg17` | **248 of 248** on Postgres 18 and 17 (about 64 new: validation incl. every competition × every age 0–14, mobile formats, consent, settings window, duplicates, the action with a fake client recording every write, 3 database tests for the new column) |
| Mutation checks | 6 of 6 deliberate breakages caught (owner id sent, email from form, consent not enforced, age band not enforced, registration open without a window, duplicate check removed); originals restored |
| `npm run build` | exit 0; static `/` and event pages; dynamic auth and register routes |
| `npm run test:e2e` | **34 of 34** (adds the expired-session notice) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| UI at 360 px (real components on a temporary preview route, since deleted) | no overflow; minimum contrast 5.02; inputs 48 px; consent labels and every control labelled; `tel`, `numeric` and `one-time-code`-style attributes correct; the Tamil age placeholder was truncated and was shortened. Not run: axe, keyboard-only pass, reduced motion, desktop screenshots |

### 15.4 Database integration status: UNVERIFIED (blocked on approvals)
The action, validation, consent and duplicate logic are verified against a fake client; ownership and the write permissions are verified by the earlier real-database and live RLS tests (the parent write path is unchanged). **Not yet verified:** a real registration saved to the dev database through the real form and refreshed. Blockers:
1. **Registration is closed on dev**, so the database rejects every insert (`submissions_closed`), as designed. Opening it means setting `event_settings` (window and consent version `v0-provisional`) on dev: an administrator action I did not take.
2. **The `media_consent` migration is not applied** (15.2).
3. A real signed-in parent needs real email codes (M3A delivery blockers) or the approval-gated code route below.
**Prepared, not run:** `e2e-live/registration.live.spec.ts` (run by `npm run test:e2e:live`). With approval it would, on the dev project only: create two dummy users, temporarily open registration (and restore the exact original settings), register children through the real form, and check that the row has the right owner, verified email, consent version and timestamp, `draft` status and no video; refresh persistence and editing without re-stamping consent; duplicates blocked while siblings and other competitions are allowed; another parent cannot see the draft; an expired session is explained and saves nothing; closed registration hides the form and keeps the upload and submit buttons disabled. It skips, rather than applies, the migration if the column is missing, deletes everything it created, and compares counts and settings with a baseline. It shares a setup helper with the M3A live spec.

### 15.5 Decisions and follow-ups
Owner: approve applying the migration to dev, approve the live run, and approve an opening date and consent version (the hospital's call, with legal review of the wording, D5). Known limits: consent is recorded once at creation, so a later consent version does not retroactively re-consent existing drafts (decide the rule before M4 finalization); the 10-registration cap and the save rate limiter are app-level; the Tamil text is mine (D13); the "Register" button on public pages stays inactive by design.

### 15.6 M3B.1 media-consent migration applied to DEV (2026-11-05)

**Authorization and guards:** the owner approved applying the one reviewed additive migration `20261105000400_media_consent.sql` to `rio-childrens-day-dev` (ref `rajbfcoxolnjgiqgvflm`) only. Before applying: the target was re-verified (project in the logged-in account, `ACTIVE_HEALTHY`, `ap-southeast-1`; pooler URL, host region and approved ref all agree; differs from the production project); a push aimed at the production ref was refused (exit 3); the dry-run listed **only** migration 00400; migrations 00100–00300 were hash-identical to the verified set; the SQL is three statements (add one `boolean not null default false` column, grant insert and update on that column to `authenticated`) with no `drop`, `truncate`, `delete`, `revoke`, policy, trigger, function or `security definer` anywhere outside comments.

**Execution:** `npm run db:dev:push` ran **once** with `RIO_CONFIRM_PUSH` set for that single process only (unset in the shell afterwards, absent from `.env.live`). Exit 0; it applied exactly `20261105000400_media_consent.sql`. Output was captured and scanned: no credential or connection URL. No retry, reset or rollback.

**Schema verification (real database, read-only inspections before and after):**
| Item | Result |
|---|---|
| `submissions.media_consent` | exists: type `boolean`, nullable `NO`, default `false`, not generated; the table went from 20 to 21 columns and every pre-existing column is unchanged |
| Migration history | `…000100`, `…000200`, `…000300`, `…000400` |
| Grants | the only grant change is `authenticated` on `submissions`: `media_consent` added to the insert and update column lists. The real grant snapshot is identical to the tested snapshot (14 entries), which includes the new column |
| Everything else | 24 inspection sections compared pre vs post: **only three differ** (history, grants, submissions columns). Identical: the 9 tables and 2 views with RLS flags, all **22 policies**, all 16 functions, all 13 triggers, view definitions and ACLs, default privileges, schema access, the **six events (same hash)**, settings, row counts, extensions |
| Data | untouched: `event_settings` still all null (registration remains closed), 0 submissions, no test users or registration records created |

**Real-database structural analysis:** 27 of 30 checks pass; the three flagged items are the known, non-regression artifacts documented in M2.3 and M2.4 (the `search_path` setting prints with escaped quotes, though the function definitions are byte-identical before and after; `pgcrypto` is a Supabase default extension; the "other tables empty" check counts the single documented banned dummy admin role from the M2.4 live run). **Supabase advisors:** 8 findings, 0 warnings, none new (the 2 accepted security-definer-view errors, 4 unindexed foreign keys, 2 unused indexes; the unused-index count fell from 5 because the live tests exercised some).

**Local checks:** `npm run lint`, `typecheck` exit 0; `npm test` and `npm run test:pg17` **248 of 248** on Postgres 18 and 17 (including the four-migration replay from empty, the grant snapshot, the recovery-script replay and the three media-consent behaviour tests). One read-only inspection (`submissions_columns`) was added to the guarded allowlist; guard tests 43 of 43.

**Result:** PASS. **Remaining blockers for a real registration on dev (unchanged by this step):** registration is closed (an administrator must set the window and a consent version the app knows; the provisional wording needs the hospital's legal review, D5), and a real signed-in parent needs real email codes or the approval-gated route. The prepared `e2e-live/registration.live.spec.ts` is still not run; its media-consent precondition is now satisfied.

### 15.7 M3B.2 live registration integration test (2026-11-05)

**Authorization:** one controlled run against `rio-childrens-day-dev` (ref `rajbfcoxolnjgiqgvflm`) only, using the existing guarded confirmation (`RIO_LIVE_CONFIRM` set for that single process). Administrative credentials were used only to create and delete dummy users, fetch their one-time codes, set the registration window for the run and restore it. Permission assertions were written against real user sessions (a user JWT obtained through `verifyOtp`), not the secret key. No OTP security or RLS change, no migration change, no production access, nothing committed, pushed or deployed.

**Harness changes before the run (code only, no database call):** the run is filtered to `registration` so the older spec does not also run; read-backs use user-JWT clients instead of the secret key; the registration window is 45 minutes (not 6 hours); the settings write is checked. The first launch failed at module load (`import.meta` in `scripts/db-dev.ts` cannot be loaded by Playwright's CommonJS TypeScript loader) before any connection was made, so the guard moved unchanged into `scripts/live-target.ts` (`db-dev.ts` re-exports the same names; `tsconfig.json` gained `allowImportingTsExtensions`). Guard tests and all 248 unit tests passed afterwards and the spec listed 7 tests.

**Result of the single approved run: FAILED at the first step. 1 failed, 6 did not run.**
| # | Live test | Result |
|---|---|---|
| 1 | Register through the UI (consent error, then save) | **Failed**: after typing the one-time code and pressing Verify, the browser stayed on `/signin/verify?event=kutti-pesalar` instead of reaching `/events/kutti-pesalar/register`. The page snapshot shows an empty code field and the message "Enter the 6-digit code." |
| 2–7 | Refresh and edit; duplicates and siblings; parent B isolation; expired session; registration-closed state; upload and submit disabled | Did not run (serial suite stopped) |

The user-session helper (`verifyOtp` with a generated code) did work in the suite's setup, so the project accepts the generated code; the app's own form did not. **Cause not confirmed.** The app requires exactly six digits (`lib/auth/schemas.ts`, input `maxLength={7}`). The public Auth settings expose no OTP-length field, so it could not be read without the dashboard. Leading suspects: (a) the dev project's email OTP length is not 6; (b) the typed value was lost to a hydration race. After the run, `assertSixDigitCode` was added to `e2e-live/helpers.ts`: a future run fails immediately with the code's length (never the code) if it is not 6 digits. It has not been run live.

**Cleanup and restoration (verified independently, read-only, after the run):** `event_settings` back to all null (registration closed); the six seeded events hash-identical to the pre-run snapshot; 0 submissions; 0 leftover tagged dummy users; the only non-baseline records are **2 new audit rows** (audit now 99; the post-run scan finds no personal-looking text and only dummy or null actors, and the rows are the settings change and its restoration, which fits the 10 `event_settings` entries) and the pre-existing banned dummy admin role from M2.4. The failed run left a git-ignored `test-results/` page snapshot, which was deleted.

**Findings by area:**
- Registration persistence through the real UI: **UNVERIFIED** (not reached).
- Parent isolation, duplicate rules, age band, consent, session-derived email and owner, expired session, closed state: **not verified live**. They remain covered by the local PGlite suite (real role contexts) and the unit tests, 248 of 248.
- Upload and final submission: still disabled in the app; the live check did not run.
- No test was retried and no setting outside the approved scope was changed.

**Local checks after the changes:** `npm run lint`, `typecheck` exit 0; `npm test` 248 of 248; `npm run build` exit 0; `npm run test:e2e` 34 of 34. Migrations 00100–00300 hash-identical; 00400 unchanged.

**Result: FAIL (live), UNVERIFIED (persistence).** **Remaining blockers:** (1) the owner confirms the dev email OTP length is 6 (or approves a separate change to make the app accept the configured length); (2) a new explicit approval for one re-run; (3) the Tamil copy and provisional consent wording remain unreviewed (D13, D5).

### 15.8 M3B.2A OTP form failure diagnosis (2026-11-05)

**Scope kept:** no hosted Supabase setting, RLS, migration or production change; no hosted user or record created; `test:e2e:live` not run; nothing committed. Every value used was a made-up number; no real code was read, logged or recorded.

**Which layer produced the error: CONFIRMED, server-side validation.** The text "Enter the 6-digit code." exists in one place (`copy.errors.invalidCode`) and is returned only by `verifyCode` in `app/signin/actions.ts` when `otpSchema` fails, before Supabase is called. Supabase Auth errors are mapped to different messages (`verifyErrorMessage`: wrong or expired, too many attempts, sign-in failed). There is no browser-side validation (the form is `noValidate`). So the failed run never reached Supabase Auth: the value the server received was not exactly six digits after spaces were removed.

**What was ruled out, by measurement (intercepted request, server action never run):**
| Suspect | Result |
|---|---|
| Wrong input name / FormData handling | The browser posts the field as `code`; the server reads `formData.get("code")`. Six synthetic digits arrive exactly |
| Typing key by key vs `fill()` | Both submit the same six digits (Enter and the button) |
| Hydration race (typing before the page is interactive) | 5 of 5 immediate fill-and-click attempts, with no wait, submitted the typed digits |
| Controlled-state loss | The input is uncontrolled. An **empty field after the error is normal**: React resets the form once the action returns, so the failed-run snapshot cannot show what was sent |
| Server validation | A made-up 8-digit value gives exactly the failed run's symptoms: same URL, same message, empty field |

**Root cause: NOT fully confirmed.** The only input that reproduces the failure offline is a value that is not six digits, and the client and the old harness both submitted what they were given. The most likely trigger is therefore that the dev project issued a one-time code that is not 6 digits long. That cannot be read without creating a hosted user or opening the dashboard. Supabase's documented default is 6 (range 6 to 10), but a third-party report says some projects default to 8, so the dashboard value is the thing to check. Note the app has a hard limit that would block a parent too: the field allows at most 7 characters and the server accepts only 6 digits, so if the hosted length is not 6, real parents could not sign in either. This is a risk, not a confirmed defect, so the validation was **not** loosened.

**Files changed (test and harness only; no application code changed):**
- `e2e/otp-form.spec.ts` (new): 5 browser regression tests (exact submit by fill and by typing, no lost input before hydration, server rejection of a wrong-length value with the 6-digit message, 7-character limit).
- `scripts/live-code.ts` (new) and `scripts/live-code.test.ts` (new, 3 tests): `assertSixDigitCode` fails fast naming only the length, never the code; `describeVerifyFailure` names the refusing layer.
- `e2e-live/helpers.ts`: `signInThroughApp` now checks the generated code is six digits **before** typing, waits for the form to be interactive (resend button enabled), confirms the field holds exactly the digits, and on failure reports which layer refused. `userSession` uses the same length check.

**Regression-test strength:** mutating the form (field name and max length) made 4 of the 5 new browser tests fail; the form was restored byte-identical and re-verified.

**Checks:** `lint` and `typecheck` exit 0; `npm test` **251 of 251**; `npm run build` exit 0; `npm run test:e2e` **39 of 39**; migrations 00100–00300 hash-identical, 00400 unchanged.

**Live retest:** not justified yet. The next step is free and needs no records: the owner reads Authentication, Providers, Email, OTP length on `rio-childrens-day-dev`. If it is 6, a re-run is justified (the helper now explains any failure precisely). If it is not 6, decide whether to set it to 6 (the production project must also be 6) or approve an app change to accept the configured length.

### 15.9 M3B.2 final live retest (2026-11-05)

**Authorization:** one run of `registration.live.spec.ts` against `rio-childrens-day-dev` (ref `rajbfcoxolnjgiqgvflm`) only. It was run as `RIO_LIVE_CONFIRM=<dev ref> npm run test:e2e:live -- registration`, the same filtered form as before, because the approval names the registration suite (without the filter the older parent sign-in spec would also run).

**Pre-run checks (all passed):** read of the suite and helpers; lint and typecheck exit 0; guard and OTP-helper unit tests 46 of 46 (these include refusal of the production ref); live negatives: a wrong confirmation value and no confirmation were both refused (exit 3), the approved dev ref was accepted; no `console` output or code printing in the live files; `afterAll` cleanup is written to run even when a test or `beforeAll` fails; baseline snapshot taken (settings all null, 6 events hash `e056688e3a9568ee`, 0 submissions, 1 banned dummy admin, audit 99).

**Result: FAILED before any browser step. 1 failed, 6 did not run, 0 passed.** The harness's new length check stopped the run when it fetched the first dummy parent's one-time code (in `beforeAll`, through `userSession`):

> the project issued a 8-character one-time code (digits only: true); the app accepts exactly 6 digits. Nothing was submitted.

**OTP report:**
- Generated code length: **8**. Character class: **digits only**.
- Submitted form-data length: **none**. Nothing was typed or submitted; the check refused first.
- Layer: neither client validation, the server action nor Supabase Auth. The Auth server issued the code correctly; the harness precondition caught the mismatch with the app's six-digit rule.
- **This explains the first failure (§15.7) exactly:** the app received an 8-digit value and its server-side validation answered "Enter the 6-digit code." The M3B.2A diagnosis (§15.8) is now confirmed: the app form and the typing were correct.
- **Contradiction to resolve:** the owner reports the dashboard shows Email OTP length 6, yet the Auth server issues 8 digits. The generated code uses the project's configured length, so either the dashboard value was read on another project, was not saved or applied, or the displayed and effective settings differ. It cannot be resolved from the repository, and no hosted setting was touched.

**Live scenarios:** none ran, so these are all UNVERIFIED: real draft persistence, refresh and resume, edit, age restriction, mandatory consent, session-derived email and owner, duplicates and siblings, parent B isolation, expired session, closed-window state, upload and submit disabled. Local coverage is unchanged (251 unit tests, 39 browser tests, role-context database tests).

**Cleanup and restoration (verified read-only afterwards):** `event_settings` back to all null (registration closed); six events hash-identical (`e056688e3a9568ee`); 0 submissions; 0 tagged dummy users left; the pre-existing banned dummy admin and its role untouched; row counts identical to the baseline except audit. **Audit log: +2 rows** (99 to 101), both on `event_settings` (the temporary window opening and its restoration; ids and states only, no personal-looking text, actors dummy or null). Audit rows are append-only and cannot be removed. The git-ignored `test-results/` snapshot was deleted. The confirmation variable existed only for that one process and is not set in the shell.

**Security findings:** no secret, token, email address or code appeared in any output (only the length and the digits-only flag). No production access, no hosted setting, RLS or migration change, no retry, nothing committed. The live guard refused wrong and missing confirmations. **Finding:** the app's fixed six-digit rule and a project that issues 8 digits would stop every real parent from signing in; this must be settled before launch on both the dev and the production project.

**Result: FAIL (live), UNVERIFIED (persistence and isolation).** **Options for the owner (any change is theirs or needs approval):**
1. Re-check the OTP length on the dev project (correct project, saved) and set it to 6 if it is not, then approve one more run.
2. Or decide that 8 digits is wanted, and approve an app change to accept the configured length (the field limit and server validation would change, with tests), keeping the harness check in step.
3. Either way, check the production project's setting later without touching it from this repository.

### 15.10 M3B.2B configurable email OTP length (2026-11-05)

**Why:** the dev Supabase project issues 8-digit codes (measured by the harness, length only) while the app hard-coded 6 in the schema, the input limit, three messages and the harness. Supabase allows 6 to 10 and the setting is the project's, so the app now follows one setting instead of a constant. No hosted setting, RLS or migration was changed; production was not touched; no live test was run; nothing committed.

**Configuration introduced:** `RIO_OTP_LENGTH`, server-only (never `NEXT_PUBLIC_`), read at request time by `lib/auth/otp-length.ts`.
- Unset or blank = **6** (the default is not 8 anywhere).
- Allowed: whole numbers 6 to 10. Anything else (`5`, `11`, `abc`, `8.5`) is a configuration error: the sign-in and code pages show the existing "Sign-in is unavailable" message with no form, and the server action refuses without asking Supabase (fail closed; the error text never echoes the value).
- Dev: `RIO_OTP_LENGTH=8` added to the git-ignored `.env.local` (`.env`, the production file, was not touched). Documented in `.env.example`. **Production and every Vercel environment must set this to match that Supabase project's real OTP length before launch** (leave it unset only if that project is 6).

**What follows the setting:**
| Place | Behaviour |
|---|---|
| Server validation (`otpSchema(length)`) | exactly `length` ASCII digits after spaces are removed; stays a string, so **leading zeros are kept**; other scripts' digits and over-long input are rejected |
| `verifyCode` action | reads the length per request; wrong shape returns the length-aware message without contacting Supabase; the code is passed to `verifyOtp({ type: "email" })` unchanged |
| Code input | `maxLength` = length + 2 (room for pasted spaces; the server checks the exact length); text input with numeric keypad, so zeros are never dropped; smaller type on phones so 10 digits fit at 360 px |
| Messages | the sign-in sentence, the field label and the error are built from the length, Tamil and English with the same number; no "six" left (the Tamil word for six was replaced by a numeral) |
| Live harness | uses the same `resolveOtpLength` from the same `.env.local`; fails before typing, naming only the two lengths, if the issued code differs |

**Admin-generated token flow checked:** the harness gets codes from `generateLink({ type: "magiclink" })` and verifies them with `verifyOtp({ type: "email" })`, the same type the app uses (`EmailOtpType` allows both; the earlier M3B.2 run's `verifyOtp` accepted such a code). The generated and the emailed code come from the same project setting.

**Files changed:** `lib/auth/otp-length.ts` (new), `lib/auth/schemas.ts`, `lib/auth/messages.ts`, `lib/auth/rate-limit.ts` (comment), `app/signin/actions.ts`, `app/signin/page.tsx`, `app/signin/verify/page.tsx`, `components/auth/otp-form.tsx`, `scripts/live-code.ts`, `e2e-live/helpers.ts`, `.env.example`, and `.env.local` (git-ignored). Tests: `lib/auth/auth-lib.test.ts`, `app/signin/actions.test.ts`, `scripts/live-code.test.ts`, `e2e/otp-form.spec.ts`, `e2e/auth.spec.ts`.

**Regression tests:** schema for every length 6 to 10 (exact, one short, one long), spaces, leading zeros, letters, Arabic-Indic digits, 65-character input; configuration parser (default, range, fail-closed, no echo); messages (same number in Tamil and English, no leftover six); action at the default 6, at 8, at every length, an incorrect eight-digit code (Supabase says wrong or expired), and invalid configuration (unavailable, no Supabase call); browser: exact submit with leading zero by fill and by typing, no lost input before hydration, wrong length refused with the configured number, the input limit, the label and sign-in sentence, fit at 360 px. Mutation checks: hard-coding 6 in the action failed 5 tests; hard-coding 6 in the schema failed 8.

**Checks:** `lint` and `typecheck` exit 0; `npm test` **262 of 262**; `npm run build` exit 0; `npm run test:e2e` **41 of 41** at the configured 8, and the full suite also passes at 6 and at 10 (the browser tests read the same setting; one run at 6 hit a harness timing race on an aborted pre-hydration POST, fixed and then 9 of 9 repeated runs passed); an invalid length (5) shows "unavailable" with no form. Migrations 00100–00300 hash-identical, 00400 unchanged.

**Open item:** why the dashboard shows 6 while the project issues 8 is still unexplained. The app no longer depends on the answer, but `RIO_OTP_LENGTH` must always equal what the project really issues. If the dashboard value is later corrected to 6, set `RIO_OTP_LENGTH=6` (or remove it) for that environment.

**Readiness for the live retest:** yes. The code, the form and the harness now agree on 8 for dev. The retest still needs a new explicit approval.

### 15.11 M3B.2C final registration integration retest (2026-11-05)

**Authorization:** one run of the filtered `registration.live.spec.ts` against `rio-childrens-day-dev` (ref `rajbfcoxolnjgiqgvflm`) only, with its guarded confirmation for that single process. No code, hosted setting, migration or RLS change; no production access; nothing committed; no retry.

**Preflight (all passed):** lint and typecheck exit 0; 95 related unit tests pass; `RIO_OTP_LENGTH` resolves to **8** in the process that loads `.env.local` (the Playwright config, whose workers and the app server it starts inherit it) and is defined only in `.env.local` (not `.env` or `.env.live`); the harness uses `generateLink({ type: "magiclink" })` and `verifyOtp({ type: "email" })`, the app's own type; the live guard refused a wrong and a missing confirmation and accepted the dev ref; production refusal is covered by the guard tests; cleanup is in `afterAll` (runs on failure); baseline taken (settings all null, six events hash `e056688e3a9568ee`, 0 submissions, one banned dummy admin, audit 101).

**Result: 1 failed, 6 did not run, 0 passed (the suite is serial).**
| Step | Result |
|---|---|
| Dummy parents created, temporary window opened, two real user sessions obtained | passed (the 8-digit code length check passed) |
| Sign in through the real app: the code was typed into the real form and accepted | **passed**: a valid session was created and the browser reached `/events/kutti-pesalar/register` |
| Registration page for the chosen competition opens with the verified email shown | **passed** |
| First Save without guardian consent: refused with "Guardian consent is needed", and **nothing saved** (read back with the parent's own session) | **passed (consent validation verified live)** |
| Tick consent and Save again: expected redirect to `?draft=<id>&saved=1` | **failed**: the page stayed on `/events/kutti-pesalar/register` |
| Tests 2 to 7 (refresh and edit, duplicates and siblings, parent B isolation, expired session, closed state, upload and submit disabled) | did not run |

**Verified cause of the failure (an application defect, not the harness, OTP or Supabase):** the page snapshot after the failed Save shows the age dropdown back on "Choose" with the error "Choose an age from 3 to 12", while the child name, parent name and mobile kept their values. The test, like a real parent, fixed the one mistake (consent) and pressed Save again without re-picking the age, which the form had silently cleared. An offline probe (a bundle of the same pattern: `useActionState`, a form action that fails validation and echoes the values back, text input and `<select>` both using `defaultValue` from the returned values, React 19.3.1, in the installed Chrome) reproduced it exactly: before the failed submit name and age were kept; after it the name was kept and the age was empty. Text inputs follow a changed `defaultValue`; the select does not, and React resets the form after the action. The probe lived in the scratchpad only; no repository file was touched. This affects every validation error and every duplicate error, not just consent. **Not fixed in this module** (the instruction was not to change code).

**What this does and does not prove:**
- Verified live: real OTP sign-in at 8 digits, a valid session, the right registration page, mandatory-consent refusal with nothing saved, and the verified email and event on the page.
- UNVERIFIED live (not reached): draft persistence, refresh and resume, edit, age restriction, duplicate and sibling handling, parent isolation, expired session, closed state, upload and submit disabled.

**Cleanup and restoration (verified independently, read-only, afterwards):** `event_settings` back to all null (registration closed); six events hash-identical (`e056688e3a9568ee`); 0 submissions; the test users are gone (one auth user remains, the pre-existing banned dummy admin, with its `admin` role untouched); every table count equals the baseline except the audit log. **Audit growth: +2 rows (101 to 103), both on `event_settings`** (the temporary window opening and its restoration; ids and states only, no personal-looking text, actors dummy or null). The audit log is append-only, so these remain. The git-ignored `test-results/` folder was deleted (a copy of the scrubbed page snapshot is in the scratchpad only). The confirmation variable existed for that one process and is not set in the shell.

**Security findings:** no OTP value, credential, token, cookie or personal data was printed (the page snapshot contains only made-up names and a masked email). Server-side consent enforcement held (nothing was saved without it). Consent wording remains provisional (D5). No security defect found; the defect found is a usability and data-entry one.

**Result: FAIL (live), UNVERIFIED (persistence, edit, isolation).** **Next:** a small fix for R18 with a browser regression test (offline), then one more approved live run. Recommended as module M3B.2D.

### 15.12 M3B.2D age selection preserved after errors (2026-11-05)

**Scope kept:** only `components/registration/registration-form.tsx` changed in the app. No migration, RLS, OTP or auth change; no hosted user or registration created; no live test run; no production access; nothing committed.

**Confirmed root cause (reproduced on the real component):** React 19 resets a form after every action. A text input's `defaultValue` follows the values the failed action echoes back, so the name, parent name and mobile survived. A `<select defaultValue>` does not follow a changed default, so the reset sent the age to "Choose". A parent who fixed the one mistake (for example ticked consent) and pressed Save again sent no age and got an age error. Before the fix, the new offline spec failed **8 of 10** tests on the real form (missing consent, invalid mobile, duplicate, save failure, repeated failures, editing, keyboard, phone). A first attempt, a controlled select, was tried and did **not** work: the reset still changed the DOM to the first age, because React sees no state change to re-apply.

**Fix (3 lines of logic):** the select is keyed by the age the action returned, with that age as its default:
```
const age = v?.childAge ?? initialAge;   // initialAge = the saved draft's age, or ""
<select key={age} defaultValue={age} ...>
```
A changed age remounts the select with the new default, which is exactly what the post-action reset restores. Validation is untouched: the server still checks the age against the competition's band. Fields reset only on a successful save (which redirects to the saved draft, a new form instance) or a page load.

**Regression tests (new, offline, real browser):** `e2e/registration-form.spec.ts` bundles the REAL `RegistrationForm` and runs it in the installed Chrome with a fake action (`e2e/fixtures/fake-save-draft.ts`) that runs the real `parseRegistration` and returns the real state shapes. Nothing contacts Supabase. 10 tests: missing guardian consent then tick consent only and save; invalid mobile then fix and save; duplicate answer then rename and save; save failure keeps every value; three failures in a row plus a deliberate age change; age never chosen stays on "Choose" with the age message; only the competition's ages (8 to 12) are offered and a tampered age is refused; editing a draft starts on its saved age and keeps it after an error; keyboard only (arrow keys, Tab, Enter, Shift+Tab); a 360 px touch screen (tap, no horizontal scroll). `rolldown` (already installed through Vitest) was declared as an exact devDependency (`1.2.16`) because the test now imports it; no new code was installed.

**Results:** `lint` and `typecheck` exit 0; `npm test` 262 of 262; `npm run build` exit 0; `npm run test:e2e` **51 of 51** (41 earlier plus 10 new); the new spec also passed 3 repeat runs; migrations 00100–00300 hash-identical and 00400 unchanged. Not measured: the real page in a browser against the live project (no session offline).

**Result: PASS (offline).** **Live retest:** justified, with a new explicit approval; it should also confirm persistence, refresh and edit, duplicates and siblings, parent isolation, the expired session, the closed state and the disabled upload, none of which has run yet.

### 15.13 M3B.2E final live registration verification (2026-11-05)

**Authorization and scope:** one run of the filtered `registration.live.spec.ts` against `rio-childrens-day-dev` (ref `rajbfcoxolnjgiqgvflm`) only, with its guarded confirmation for that single process. Production, migrations, RLS, hosted Auth settings and application code were not touched; nothing committed or deployed; no retry. One test-file edit before the run: a single assertion that the age still reads 9 after the consent error (M3B.2D check), added so the run proves that step directly.

**Preflight (all passed):** lint and typecheck exit 0; 95 related unit tests pass; the age fix (`key={age}`) is in the source and the production build is newer than it; `RIO_OTP_LENGTH` resolves to 8 and is defined only in `.env.local`; port 3100 was free so Playwright started the fresh build; the live guard refused no and wrong confirmation (exit 3) and accepted the dev ref; assertions use real parent sessions (user JWT through `verifyOtp`, and the real browser); cleanup is in `afterAll`; baseline taken (settings all null, six events hash `e056688e3a9568ee`, 0 submissions, one banned dummy admin, audit 103).

**Result: 7 passed, 0 failed, 0 skipped (34 s).**
| # | Live test | Result |
|---|---|---|
| 1 | Real sign-in with an 8-digit code; the right competition page opens; missing consent is refused and nothing is saved; **the age (9) survives the error**; ticking only consent allows the save; the draft is stored with the owner id, verified email, names, mobile, age, event, status `draft`, no video key, media consent, consent version and a fresh consent time, all read back with the parent's own session | PASS |
| 2 | The draft survives a refresh; editing the name and saving updates the same row; consent time, creation time, email and owner are unchanged | PASS |
| 3 | Re-saving the same child in the same competition is caught as a duplicate (no new row); a sibling saves (2 rows); the same child in another competition saves (3 rows) | PASS |
| 4 | Parent B opening Parent A's draft link sees an empty new form and "no registrations yet"; through the API with B's own session A's row is invisible, B has 0 rows, an update of A's row changes nothing, and A's row is unchanged | PASS |
| 5 | Session cookies cleared mid-form: Save returns to sign-in with the "session ended" explanation, and nothing is saved | PASS |
| 6 | Registration window closed by the administrator: the form is not shown ("not opened yet"), upload and submit are disabled, and the database itself refuses an insert from the parent's own session (`submissions_closed`) | PASS |
| 7 | Window reopened: upload video and submit entry stay disabled, there is no file input, and every row is still a draft without a video key | PASS |

**Verified live now (previously unverified):** OTP sign-in and session; registration persistence; refresh and resume; edit; duplicate handling and multiple children per parent; parent isolation both through the UI and through row level security; expired session; closed state enforced in the UI and the database; consent enforced server side; owner and email taken from the session, not the form; upload and final submission disabled. Age band and invalid-input rules remain covered by the unit tests and the offline form tests (the live run exercised the age-selection path and the consent rule).

**Cleanup and residue (verified independently, read-only, after the run):** `event_settings` is back to all null, so registration is closed again; the six seeded events are hash-identical; 0 submissions and no test users remain; the pre-existing banned dummy administrator and its `admin` role are untouched (one auth user, one role row); every table count equals the baseline except the audit log. **Audit growth: +11 rows (103 to 114):** 7 on `submissions` (3 inserts, 1 update, 3 cleanup deletes) and 4 on `event_settings` (window opened, closed for test 6, reopened for test 7, restored). Ids and states only; the scan found no personal-looking text and every actor is a dummy user or null. The audit log is append-only, so these remain. The `test-results/` folder was removed and the run output holds no email address, token or code. The confirmation variable existed for that one process and is not set in the shell.

**Security findings:** none new. RLS isolation held for a second parent on read and write; the database refused writes with the window closed; no secret, OTP, credential or participant data was printed. Standing items: the consent wording is provisional and legally unreviewed (D5); the Tamil copy needs native review (D13); `RIO_OTP_LENGTH` must be set per environment to match each Supabase project; the dashboard-6 versus issued-8 discrepancy on dev is still unexplained.

**Result: PASS.** M3B is complete on DEV. Registration stays closed there until an administrator sets the window and the reviewed consent wording.

## 16. M4A Cloudflare R2 environment setup (2026-11-05)

**Scope kept:** configuration and an offline check only. No object was uploaded, listed, read or deleted; no network call to Cloudflare or Supabase was made; no value was printed; no hosted or production resource touched; nothing committed.

**Configuration validation (names and statuses only, from `npm run r2:check`):**
| Variable | `.env.local` (what the Next.js server reads) | `.env.live` (dev tooling file) |
|---|---|---|
| `R2_ACCOUNT_ID` | **missing** | present, well formed |
| `R2_ACCESS_KEY_ID` | **missing** | present, well formed |
| `R2_SECRET_ACCESS_KEY` | **missing** | present, well formed |
| `R2_BUCKET_NAME` | **missing** | present, well formed |
No `NEXT_PUBLIC_` variable holds an R2 or secret value. `.env.local` was left exactly as it was (Supabase URL, publishable key, allowed project ref and `RIO_OTP_LENGTH=8` preserved). `.env.local`, `.env` and `.env.live` are all Git-ignored (`.gitignore`: `.env`, `.env.*`, only `!.env.example` tracked) and none is tracked. **Result for the app: the four settings are not visible to the Next.js server yet**, so the upload step correctly stays disabled. The variable name is `R2_BUCKET_NAME` (the name already used in `.env.live`); the earlier draft name `R2_BUCKET` was removed.

**Server-only S3 client:** `createR2Client` in `lib/storage/object-store.ts`: AWS SDK v3 `S3Client`, region `auto`, endpoint `https://<account id>.r2.cloudflarestorage.com`, path-style addressing, checksums only when required (R2 rejects the SDK's default CRC32 on a presigned PUT). Credentials come only from the four server variables. A value-free `r2EnvReport` (and `npm run r2:check`, which prints names and ok / missing / badFormat) is the validation; `readR2Config` returns the settings only when all four are well formed and no secret-looking `NEXT_PUBLIC_` name exists.

**Files changed:** `lib/storage/object-store.ts`, `lib/storage/object-store.test.ts`, `scripts/check-r2-env.ts` (new), `package.json` (`r2:check` script), `.env.example` (placeholders only). **Tests added (offline, 8 new):** the report for good, missing and badly formed values, that it never contains a value, that a secret-looking public name blocks readiness; the client's region, endpoint, path style and checksum settings with no network call; `.gitignore` and `.env.example` hygiene.

**Checks:** `lint` and `typecheck` exit 0; `npm test` **317 of 317**; `npm run build` exit 0; `npm run test:e2e` 51 of 51. **Result: PASS** for the setup and the offline checks; **UNVERIFIED** for any real R2 behaviour.

**State of the wider M4A upload build (interrupted, not finished):** present but incomplete and not applied anywhere: migration `20261105000500_video_uploads.sql` (prepared, NOT applied to any project; 17 database tests and 17 end-to-end flow tests against a fake bucket pass), the upload service, the bucket and admin clients, the server actions, the upload panel and its wiring on the registration page (shown only when R2 and the secret key are configured), the cleanup job, and the CSP entry for the one R2 host. **Not yet written:** tests for the server actions and for the static security boundaries, the offline browser test of the upload panel, the Postgres 17 run, and the M4A report. Nothing in the live app changes until the four settings and `SUPABASE_SECRET_KEY` reach the server and the migration is applied.

**Next step for a real R2 connection test (needs your OK):** (1) put the four R2 values in `.env.local` (or copy them from `.env.live` yourself; I did not move credentials between files); (2) confirm the R2 token is scoped to that one bucket and the bucket has no public domain; (3) approve one read-only check (`HeadBucket`, or `ListObjectsV2` with a limit of 1) against that bucket: no upload or delete. Then finish the M4A build and its offline tests before any real upload.

## 17. M4A secure private video upload: offline completion (2026-11-05)

**Scope kept:** no production access; no real R2 call of any kind (no upload, read, list or delete); no migration applied or dry-run against any project; no hosted write; nothing committed. The upload path is **disabled** in the running app (see 17.7).

### 17.1 Environment
The four R2 variables were copied from `.env.live` into `.env.local` by a script that printed only the variable names: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`. The Supabase and OTP lines were not changed (a hash of every `NEXT_PUBLIC_` and `RIO_` line is identical before and after). `.env.local` and `.env.live` are both Git-ignored and untracked. `npm run r2:check` on `.env.local` alone: all four **ok**, no secret-looking public name, client region `auto`, path-style, checksums only when required. Next's own loader (`@next/env`) resolves all four. **Client bundle scan** of the production build (`.next/static`, 28 files): the four values appear **0** times, and the names `R2_SECRET_ACCESS_KEY`, `R2_ACCESS_KEY_ID` and `SUPABASE_SECRET_KEY` appear **0** times; the server output holds no inlined value either. The only browser-visible trace is the account host in the Content-Security-Policy `connect-src` (it is in every presigned URL anyway). `SUPABASE_SECRET_KEY` is **not** in `.env.local` (the instruction was to copy only the four), so `uploadsConfigured()` is false and the upload step stays disabled.

### 17.2 Upload architecture
Browser to private bucket directly; the app server never sees the video.
1. **Start** (`requestVideoUpload`, server action): identify the parent from their own verified session (`getUser`), never from the request; rate limit 10 per 10 minutes; check the declaration (MP4, MOV or WebM, 100 KB to 100 MB, 30 to 90 s); call `issue_video_upload` (service role only), which locks the entry, requires it to be the parent's own, a draft or uploaded, with registration open, bounds issuance (8 per entry per hour, 30 per parent per day), retires older unused authorizations and inserts a row whose random id is the opaque object id; then sign a **15-minute PUT** for `pending/<id>`, bound to the declared Content-Type. The result holds the URL, the id and the type, with no key field.
2. **Upload** (browser XHR): PUT the file with real progress, Cancel, and a clear message per failure. Retry always starts again from step 1, so every attempt has a fresh key; an old URL is never reused.
3. **Confirm** (`confirmVideoUpload`): `HeadObject` on `pending/<id>` (must exist, have an ETag and a type, and 0 < size <= 100 MB); a **conditional server-side copy** to `videos/<id>` only if the source ETag is unchanged; then `attach_video_upload`, which re-checks owner, single use, expiry (plus 10 minutes of grace), size equal to the declaration, type equal to the declaration, entry status and the window, then sets `video_key` and status `uploaded` and supersedes any previous video. Anything that does not match is rejected and both objects are deleted. **It never finalizes an entry**; "Submit entry" is a disabled button with no handler.
4. **Why two prefixes:** a presigned URL is a bearer credential valid until it expires. The verified copy lives at `videos/<id>` while the URL only reaches `pending/<id>`, so re-using the URL cannot change a verified video (tested). `pending/` is also emptied by a lifecycle rule.
5. **Abandoned objects:** an unused authorization becomes `abandoned` an hour after it expired; replaced, rejected and abandoned ones are listed by `stale_video_uploads` and deleted by `npm run uploads:cleanup` (prints counts only, needs `RIO_CONFIRM_CLEANUP=yes`, not scheduled). A verified video is never listed. Videos of withdrawn entries are deliberately not auto-deleted (takedown stays an explicit admin action).

### 17.3 Files
New: `supabase/migrations/20261105000500_video_uploads.sql`; `lib/upload/{rules,service,server,duration,cleanup}.ts`; `lib/storage/object-store.ts`; `lib/supabase/admin.ts`; `app/events/[slug]/register/video-actions.ts`; `components/registration/upload-panel.tsx`; `scripts/cleanup-uploads.ts`, `scripts/check-r2-env.ts`. Changed: `supabase/recovery/rollback_m2_dev_only.sql` (drops the new table and functions), `components/registration/next-steps.tsx`, `app/events/[slug]/register/page.tsx`, `components/registration/draft-list.tsx`, `lib/registration/messages.ts`, `next.config.ts` (CSP: the one R2 host in `connect-src`, and `media-src blob:`), `package.json` (AWS SDK v3 client and presigner, `r2:check`, `uploads:cleanup`), `.env.example` (placeholders). Tests: `lib/upload/{rules,service,server,boundary}.test.ts`, `lib/storage/object-store.test.ts`, `app/events/[slug]/register/video-actions.test.ts`, `supabase/tests/{uploads,upload-flow}.test.ts`, `e2e/upload-panel.spec.ts` with `e2e/fixtures/*` (the registration form spec now shares `e2e/fixtures/bundle.ts`). Dependency note: the AWS SDK pair is used because R2 is S3-compatible and hand-rolled SigV4 signing for presign, HEAD, copy and delete would be well over 50 lines of security-sensitive code; both packages are AWS-maintained.

### 17.4 Tests and results
| Check | Result |
|---|---|
| `npm run lint`, `typecheck` | exit 0 |
| `npm test` | **354 of 354** (21 files) |
| Database tests on Postgres 18 | 119 of 119 (17 new function tests and 17 new end-to-end flow tests among them) |
| Whole unit suite on Postgres 17 (`npm run test:pg17`) | **354 of 354** |
| `npm run build` | exit 0 |
| `npm run test:e2e` | **74 of 74** (23 new for the upload panel) |
| Mutation checks | loosening the duration rule failed 2 browser and 2 unit tests; confirming after a failed PUT failed 2 browser tests; both files restored byte-identical |
| Migrations 00100–00400 | hash-identical; 00500 hash prefix `b9295c3551d52be1` |

What the tests cover: authorization and ownership (another parent gets the same `not_found` answer for a missing entry, nothing is signed, nothing of the owner's is touched, a client-supplied key or a planted object is refused); only an object that passed HeadObject, the size and type rules and the conditional copy is attached (call order checked with spies); oversize, wrong size, wrong type, swapped between check and copy, expired, replayed and superseded uploads; R2 errors (check fails: nothing attached or deleted; copy fails: cleanup; signing fails: the authorization is abandoned); the 15-minute expiry and the grace; issuance limits; replacement and cleanup; no logging and no secret, key, name or email in any result; server-only modules never imported by client code; no public bucket address anywhere. Browser panel: size, type, the 30 and 90 s boundaries, 20 s, 95 s, an unreadable file and over 100 MB (all refused before any request, in Tamil and English), a real progress bar, the headers and body of the PUT, 403 and dropped-connection retries that use a fresh URL each time with only the second upload confirmed, Cancel, every server refusal, a mismatch retry, the replace state, a keyboard-only flow, a 360 px touch flow with no horizontal scroll, and final submission staying disabled.

### 17.5 Migration 00500 review (not applied)
Adds table `public.video_uploads` (RLS on, **no policy**, all privileges revoked from `public`, `anon` and `authenticated`; indexes on the foreign keys and status; an audit trigger recording ids and status only) and five `SECURITY DEFINER` functions with an empty `search_path`, executable by `service_role` only: `issue_video_upload`, `attach_video_upload`, `reject_video_upload`, `stale_video_uploads`, `mark_video_upload_deleted`. It changes nothing in migrations 1 to 4 and grants nothing new to `anon` or `authenticated` (the grant-snapshot test is unchanged); `submissions.video_key` and `status` stay non-writable by parents. Locks are taken entry first, then authorization, in both functions (no deadlock). Expect Supabase advisor INFO 0008 "RLS enabled, no policy" on `video_uploads`: intended, since only the service role may touch it. To apply (needs your approval): the guarded dry-run must list only this migration, then `db:dev:push` on the DEV project only.

### 17.6 Cloudflare requirements
- **Bucket:** private; the `r2.dev` public URL disabled; no custom domain. The API token scoped to this one bucket (Object Read and Write; no admin).
- **CORS on the bucket** (exact origins, never `*`): allowed origins the real site origin(s) and `http://localhost:3100` for local tests; allowed methods `PUT`; allowed headers `Content-Type`; exposed headers `ETag`; max age 3600.
- **Lifecycle rules:** delete objects with prefix `pending/` after 1 day; abort incomplete multipart uploads after 1 day.
- **Vercel:** set the same four R2 variables, `SUPABASE_SECRET_KEY`, `RIO_SUPABASE_ALLOWED_REF` and `RIO_OTP_LENGTH` per environment (server-only, never `NEXT_PUBLIC_`).

### 17.7 Remaining blockers for a real integration test
1. `SUPABASE_SECRET_KEY` is not in `.env.local` (the dev key sits in `.env.live` under another name; I did not copy it). Without it the upload step stays disabled.
2. Migration 00500 is not applied to the dev project (needs approval).
3. Real R2 behaviour is UNVERIFIED: that the presigned PUT with a signed Content-Type is accepted, that HeadObject and the **conditional copy** (`x-amz-copy-source-if-match`) behave as modelled, path-style addressing, CORS and the lifecycle rule.
4. The duration check is browser-only and non-authoritative (a determined user can bypass it); a server-side probe (for example a small ffprobe worker) is a follow-up. R2 cannot cap the size of a presigned PUT, so oversize objects are caught after upload and deleted.
5. The upload is a single PUT, not multipart and resumable as NFR4 describes; decide in M4B whether 100 MB on weak mobile networks needs multipart.
6. M4B (finalize) must re-HEAD and compare the stored ETag before locking an entry, and playback (M5) must mint short-lived signed GETs after a role check.
7. The rate limiter is in memory per server instance; the database limits (per entry and per parent) are the durable layer.
8. The Tamil upload copy is mine and needs the native-speaker review (D13).
9. Once a video is uploaded the registration details are not editable in the UI (the action and the page agree); say if parents should be able to edit them until finalization.

**Result: PASS (offline). UNVERIFIED: real R2 and a real upload.**

### 17.8 Dev Supabase secret key configured (2026-11-05)
`SUPABASE_SECRET_KEY` was added to `.env.local` (value never printed) from `RIO_LIVE_SECRET_KEY` in `.env.live`, the only secret-key variable there. **Source check (booleans only):** `RIO_LIVE_URL` and `RIO_DEV_PROJECT_REF` name the same project; that ref equals `RIO_SUPABASE_ALLOWED_REF` and the project in `.env.local`'s `NEXT_PUBLIC_SUPABASE_URL`; it differs from the production ref in `.env`; the key is not any value in `.env`; its shape is a new-style `sb_secret_` key. An opaque key cannot be tied to a project offline, so this rests on the dev-only pairing in `.env.live`; the app additionally builds Supabase clients only for `RIO_SUPABASE_ALLOWED_REF`. All other `.env.local` lines are unchanged (hash-verified; one comment line added). Both env files remain Git-ignored and untracked. **Checks:** `npm run r2:check` (now also reports `SUPABASE_SECRET_KEY`) shows all five settings ok; Next's loader resolves the key; no secret-looking `NEXT_PUBLIC_` name; lint and typecheck exit 0; `npm test` **357 of 357**; build exit 0; browser tests 74 of 74; the key value and all four R2 values appear **0** times in the client bundles and in the server output, and the secret variable names appear 0 times in client JS. **Effect:** `uploadsConfigured()` is now true, so the upload panel appears for a saved draft **whenever registration is open**; registration is closed on dev, so nothing shows today. Migration 00500 is still not applied, so a start request fails at the database step before any URL is signed. **Findings:** (1) the live registration test 7 expects the upload step to be disabled and would now fail on a re-run while registration is open; (2) `confirmVideoUpload` asks R2 for `HeadObject` before it checks the database, so a signed-in parent could trigger a read-only 404 lookup on a random id; reorder (check the authorization first, in migration 00500 and the service) before any real test; (3) an explicit enable switch (for example `RIO_UPLOADS_ENABLED=yes`) would keep the path off until migration, bucket CORS and a real test are done. None applied: this step was configuration only.

## 18. M4A.1 upload feature gate and authorization order (2026-11-05)

**Scope kept:** local changes only. No hosted Supabase change, migration 00500 **not applied** (and not dry-run), no real R2 call, uploads **not enabled**, no production setting touched, nothing committed.

### 18.1 The master switch
`RIO_UPLOADS_ENABLED` is server-only. **Only the exact value `yes`** turns uploads on; missing, empty, `no`, `YES`, ` yes`, `yes `, `true`, `1` and every other value mean OFF (tested with 19 spellings). It is `no` in `.env.local` (non-secret; `.env.local` is Git-ignored) and documented as `# RIO_UPLOADS_ENABLED=no` in `.env.example`. Uploads are `available` only when the switch is on **and** the four R2 settings and the secret key are present. It is enforced in five places, so hiding the screen is never the only protection:
1. **Page:** `uploadStep()` returns the disabled step unless the switch is on, registration is open and the entry is a draft or uploaded one (the page no longer reads the raw configuration).
2. **Authorization generation** (`requestVideoUpload`): the switch is the **first** statement, before even a session lookup; off returns `unavailable` and nothing else runs.
3. **Confirmation** (`confirmVideoUpload`): same, first statement.
4. **Dependency builder** (`createUploadDeps`): throws while the switch is off, so no R2 or secret-key client is ever built.
5. **Content-Security-Policy:** the bucket host is added to `connect-src` only when the switch is on (with it off, the built manifest names no R2 host).
Registration, consent, drafts and the disabled **Submit entry** button are unchanged (browser tests 74 of 74, registration unit and database tests unchanged). The live registration test 7 still expects uploads disabled and holds with the switch OFF; a comment in that spec says it is expected to fail by design once uploads are switched on.

### 18.2 Authorization order on confirmation
| | Before (M4A) | After (M4A.1) |
|---|---|---|
| 1 | session | switch, then session |
| 2 | upload id is a uuid | upload id is a uuid (anything else never reaches the database or R2) |
| 3 | **HeadObject on R2** | **`check_video_upload` (database): owner, unused, unexpired (+10 min grace), entry draft or uploaded, window open** |
| 4 | size/type checked only inside the final attach | HeadObject on `pending/<id>`, only for an authorized parent; size and type compared with what the authorization **declared**, before any copy |
| 5 | conditional copy (ETag) | conditional copy (ETag), unchanged |
| 6 | `attach_video_upload` | `attach_video_upload`, which **re-checks everything under row locks** (the final, atomic authorization) |
A parent who does not own the upload, an unknown id, an expired, reused, superseded or finished authorization, a closed window and a locked entry are all turned away by step 3 with **zero requests to R2**. A stranger naming another parent's real upload id and an id that does not exist receive the **identical** `not found` answer, so the existence of another parent's object is not revealed. Everything is keyed by the id the authorization names; a client can never supply a key.

### 18.3 Migration impact (prepared locally, NOT applied)
Migration 00500 gains one more function, `public.check_video_upload(p_owner, p_upload)`: `SECURITY DEFINER`, empty `search_path`, read-only, `service_role` only (revoked from `public`, `anon`, `authenticated`), returning the declared size and type. No table, policy or grant on any existing object changed; the grant-snapshot tests are unchanged. The dev-only recovery script drops the new function. New hash prefix of 00500: `321659c194f2f25d` (was `b9295c3551d52be1`); migrations 00100–00400 hash-identical. Because 00500 has never been applied anywhere, editing it in place is safe; once applied, further changes must be a new migration.

### 18.4 Files
Changed: `lib/upload/server.ts` (switch, `uploadsAvailable`, `uploadStep`, `check` adapter, builder guard), `lib/upload/service.ts` (new order, `check` in `UploadDb`), `app/events/[slug]/register/video-actions.ts`, `app/events/[slug]/register/page.tsx`, `next.config.ts`, `supabase/migrations/20261105000500_video_uploads.sql`, `supabase/recovery/rollback_m2_dev_only.sql`, `scripts/check-r2-env.ts` (reports the switch), `.env.example`, `.env.local` (git-ignored; `RIO_UPLOADS_ENABLED=no`), `e2e-live/registration.live.spec.ts` (comment only). Tests changed or added: `lib/upload/{service,server,boundary}.test.ts`, `app/events/[slug]/register/video-actions.test.ts`, `supabase/tests/{uploads,upload-flow}.test.ts`.

### 18.5 Regression tests and results
| Check | Result |
|---|---|
| `lint`, `typecheck` | exit 0 |
| `npm test` | **390 of 390** (22 files); the whole suite also on Postgres 17: **390 of 390** |
| Database tests on Postgres 18 | 127 of 127 (8 new) |
| `npm run build` | exit 0 |
| `npm run test:e2e` | **74 of 74** |
| Client bundles (28 files) and server output (102 files) | the secret key and the four R2 values appear **0** times; the names `SUPABASE_SECRET_KEY`, `R2_SECRET_ACCESS_KEY`, `R2_ACCESS_KEY_ID`, `RIO_UPLOADS_ENABLED` and `sb_secret_` appear **0** times in client JS |
| Mutation checks | asking R2 before the database check failed 8 tests; forcing the switch on failed 6; removing the switch from the confirm action failed 2; all files restored byte-identical |
Covered: flag missing, `no` and every other spelling off; `yes` with full configuration on; `yes` with anything missing still off; registration open with the flag OFF still disabled (page decision and both actions); unauthorized parent, invalid id, expired authorization and reused authorization each cause no R2 request; an R2 failure leaves no attachment and the authorization usable for a retry; authorization re-checked at attach (window closed after the bucket check, authorization superseded mid-flight); no secrets in the built output.

### 18.6 Remaining integration blockers
1. Migration 00500 is not applied to the dev project (needs approval; guarded dry-run first).
2. Uploads are OFF; turning them on is a deliberate step (set `RIO_UPLOADS_ENABLED=yes`, and update or skip live test 7).
3. Real R2 behaviour is UNVERIFIED (signed Content-Type PUT, `HeadObject`, conditional copy, path-style, bucket CORS, `pending/` lifecycle rule, token scope).
4. Duration is checked only in the browser; R2 cannot cap a presigned PUT, so oversize objects are caught after upload and deleted; single PUT rather than multipart and resumable; M4B must re-HEAD and compare the ETag at finalization; the in-memory rate limiter is per instance; Tamil copy needs review (D13).

**Result: PASS (offline).** Real R2 and a real upload: UNVERIFIED.

## 19. M4A.2 migration 00500 dry-run against DEV (2026-11-05)

**Authorization:** one guarded, non-mutating dry-run of `20261105000500_video_uploads.sql` against `rio-childrens-day-dev` (ref `rajbfcoxolnjgiqgvflm`). **The migration was not applied.** No write, rollback, recovery script, reset, delete or cleanup ran; production and Cloudflare R2 were not contacted; `RIO_UPLOADS_ENABLED` stayed `no`; `RIO_CONFIRM_PUSH` was not set in the shell; nothing committed.

### 19.1 Target
Checked by booleans (no URL, password or key printed): `RIO_DEV_PROJECT_REF` and the project in `RIO_LIVE_URL` both equal the approved ref; the pooler user is exactly `postgres.<approved ref>`, port 5432, a Session Pooler host in `ap-southeast-1`; the production project in `.env` is a different ref; the CLI is not linked to any project. The guard printed `target: dev project rajb…lm | mode: dry-run | writes: false`.

### 19.2 Migration status
Hosted history holds exactly `…000100 core_schema`, `…000200 functions_and_triggers`, `…000300 rls_and_grants`, `…000400 media_consent`. The SQL stored for each, compared with the local file ignoring comments, whitespace and separators, is **equal for all four**; the local files are also hash-identical to the recorded originals (00400 prefix `8c995be9d66de368`). Migration 00500 (hash prefix `321659c194f2f25d`) is **pending**; there is no hosted migration without a local file. The dry-run output: `upToDate: false, dryRun: true, migrations: [20261105000500_video_uploads.sql], seeds: [], roles: []`, "migrations will not be pushed". To allow this check a fixed, read-only inspection `history_statements` (a single SELECT) was added to the guarded inspection list in `scripts/db-dev.ts`; the guard tests still pass (46 of 46).

### 19.3 Planned schema changes (16 top-level statements, all on new objects)
Create table `public.video_uploads`; three indexes; enable row level security on it; revoke all on it from `public`, `anon`, `authenticated`; one audit trigger on it; create six functions (`issue_video_upload`, `check_video_upload`, `attach_video_upload`, `reject_video_upload`, `stale_video_uploads`, `mark_video_upload_deleted`); one revoke and one grant on those functions; one self-check block (fails the migration if any public table lacks RLS). **No drop, truncate, delete, rename, alter of an existing object, default-privilege change, role change or extension.** Function bodies write only `video_uploads` and `submissions`, and only when called by the service role.

### 19.4 Verification
| Check | Result |
|---|---|
| Dependencies exist on the hosted DB | `private.audit_change`, `private.submissions_open`, `public.submissions`, `auth.users` references: all present |
| Name collisions | none (no `video_uploads` table, none of the six function names) |
| Schema drift | the same 12 read-only inspections run on a scratch replay of migrations 1 to 4 and on the hosted DB (relations, functions, triggers, policies, grants, schema access, view options and ACLs, helper definitions, events, `submissions` columns, unindexed FKs): **0 differences** |
| Function security (scratch replay of 1 to 5) | all six: `SECURITY DEFINER`, empty `search_path`, owner `postgres`, **not executable by PUBLIC, `anon` or `authenticated`**, executable by `service_role`; `anon` and `authenticated` get "permission denied" when they call `check_video_upload` |
| `check_video_upload` is read-only | its source has no insert, update or delete, and it runs successfully inside a `READ ONLY` transaction |
| Table boundary | `video_uploads`: RLS on, 0 policies, no privilege for `anon` or `authenticated`, `service_role` can read; parents still cannot write `submissions.video_key` or `status` |
| Default privileges on hosted | new functions made by `postgres` in `public` get EXECUTE for `postgres` and `service_role` only (no PUBLIC, `anon` or `authenticated`), and the migration also revokes explicitly |
| Hosted roles | `postgres` (not superuser, bypass RLS), `service_role` (bypass RLS), `anon` and `authenticated` (neither) |
| Tests | 22 files, 390 tests, on Postgres 18 and 17 (the migration is replayed from empty in them) |
| **Hosted schema unchanged** | all 25 inspection sections (history, relations, functions, triggers, policies, grants, default privileges, row counts incl. audit_log 114, events, settings, ...) are byte-identical before and after the dry-run |
Two script artifacts were fixed while reviewing (they were never findings against the migration): an `search_path` check that compared the escaped text instead of the array, and a role switch issued outside a transaction, which made a refusal test look like a pass for the wrong reason; both were corrected and re-run.

### 19.5 Warnings
- Expect Supabase advisor INFO "RLS enabled, no policy" (0008) on `video_uploads`: intended, since only the service role may use it. No other new advisor finding is expected (the foreign keys are indexed).
- After applying, the upload path stays off until `RIO_UPLOADS_ENABLED=yes`; live registration test 7 expects it off.
- The recovery script (dev only) already drops the new table and functions.

**Dry-run: PASS. Safe to apply to dev: YES, after your separate explicit approval** (apply with the guarded `npm run db:dev:push`, `RIO_CONFIRM_PUSH` set to the dev ref for that one command; then re-run the read-only inspections and the advisors).

## 20. M4A.3 migration 00500 applied to DEV (2026-11-05)

**Authorization:** one run of the guarded `npm run db:dev:push` against `rio-childrens-day-dev` (ref `rajbfcoxolnjgiqgvflm`) to apply only `20261105000500_video_uploads.sql`. No Cloudflare R2 call, no test upload, no dummy registration, no production access, no recovery or rollback, `RIO_UPLOADS_ENABLED` left `no`, nothing committed or deployed.

**Note on how this was recorded:** the push ran once, earlier in this same task (its saved output shows `mode: push | writes: true`, "Applying migration 20261105000500_video_uploads.sql", one migration). The session's context was then reset before the report was written. On resuming I found the migration already applied and the dry-run reporting "Remote database is up to date", so I **did not push again** and finished the verification from the saved baseline and a fresh read-only snapshot. The baseline taken before the push is byte-identical (ignoring the random query token) to the M4A.2 post-dry-run snapshot, so nothing changed on dev between the dry-run and the push; the pre-push preflight itself is evidenced by that baseline (history: exactly 00100–00400, settings all null, 0 submissions) rather than re-run.

### 20.1 Target and preflight (booleans only)
`RIO_DEV_PROJECT_REF` and the project in `RIO_LIVE_URL` equal the approved ref; the pooler user is `postgres.<approved ref>`, port 5432; the production ref in `.env` is different; the CLI is not linked. The migration file's hash prefix is still **`321659c194f2f25d`**, the value recorded at the dry-run; 00100–00400 are hash-identical to their originals (00400 prefix `8c995be9d66de368`). `RIO_UPLOADS_ENABLED=no`; registration closed (`event_settings` all null); `RIO_CONFIRM_PUSH` is not set in the shell now (it was set for that one process only).

### 20.2 Result
Migration 00500 is **recorded as applied** (history now 00100–00500; the hosted SQL for all five equals the local files, 00500 with 16 statements). A new dry-run answers `upToDate: true, migrations: []`.

### 20.3 Schema and RLS verification (before vs after, 25 read-only inspections)
Only these sections changed, and only by the planned additions: history +1; statements +1; relations +1 (`video_uploads`: RLS **on**, **0 policies**, not forced); functions +6; triggers +1 (`audit_video_uploads`); grants +2 rows for `video_uploads` (both `anon` and `authenticated` have **no** privilege of any kind); one more foreign key to `auth.users` (`owner_id`); public relation count 34 to 39 (the table, its primary key and 3 indexes). **Unchanged:** the six events, settings, all 22 policies, every existing grant, default privileges, views and their definitions and ACLs, schema access, `submissions` columns (21), roles, extensions, the helper function definitions, the three audit-only unindexed foreign keys. Table ACL: `{postgres=arwdDxtm/postgres, service_role=arwdDxtm/postgres}` only; owner `postgres`; 0 rows.

### 20.4 Function permissions
All six exist, are `SECURITY DEFINER`, owner `postgres`, `search_path=""`, not executable by PUBLIC, `anon` or `authenticated`, and their ACL is exactly `{postgres=X/postgres, service_role=X/postgres}`: `issue_video_upload`, `check_video_upload`, `attach_video_upload`, `reject_video_upload`, `stale_video_uploads`, `mark_video_upload_deleted`. `check_video_upload` is volatility `v` (the PL/pgSQL default) but its source contains no insert, update or delete, and a scratch replay ran it inside a READ ONLY transaction (M4A.2). To allow these ACL reads, two fixed, narrow, read-only inspections (`video_function_acls`, `video_uploads_table`) were added to the guarded list in `scripts/db-dev.ts`; the guard tests still pass (46 of 46).

### 20.5 Row counts (before / after)
`events` 6/6, `event_settings` 1/1, `submissions` 0/0, `scores` 0/0, `judge_assignments` 0/0, `judge_profiles` 0/0, `user_roles` 1/1, `winners` 0/0, `audit_log` 114/114, `video_uploads` n/a/0. The six events and the settings rows are identical.

### 20.6 Database advisors (read-only)
Before: 2 ERROR `security_definer_view` (the two accepted projection views), 4 INFO unindexed foreign keys (audit-only), 2 INFO unused index. After: the same, plus **INFO `rls_enabled_no_policy` on `video_uploads` (expected and intentional)** and 3 additional INFO `unused_index` on the new, empty table's indexes (also expected: nothing has used them yet). **No new WARN or ERROR.**

### 20.7 Tests
`lint` and `typecheck` exit 0; `npm test` 390 of 390 (22 files, including the database tests that replay all five migrations); the whole suite on Postgres 17 also 390 of 390; `npm run build` exit 0; `npm run test:e2e` 74 of 74.

### 20.8 Remaining integration blockers
1. Uploads are OFF; enabling is a deliberate step (`RIO_UPLOADS_ENABLED=yes`, with live registration test 7 updated or skipped).
2. Real R2 behaviour is UNVERIFIED: the signed Content-Type PUT, `HeadObject`, the conditional copy, path-style addressing, bucket CORS, the `pending/` lifecycle rule and the token's scope. A read-only R2 connection check needs separate approval.
3. The upload functions have not been exercised against the real dev database (no dummy registration or upload was authorized); only the scratch-Postgres tests cover them.
4. Browser-only duration check, single PUT rather than multipart and resumable, M4B must re-HEAD the ETag at finalization, the Tamil copy needs review (D13).

**Result: PASS.**

## 21. M4A.4 Cloudflare R2 connectivity verification (2026-11-05)

**Authorization:** one read-only check of the configured development bucket. No object was uploaded, downloaded, copied or deleted; no bucket setting was changed; no Supabase write; no production access; `RIO_UPLOADS_ENABLED` stayed `no`; nothing committed. Nothing in the output or in this file contains an account id, endpoint, bucket name, credential, object key, signed URL or provider error message.

### 21.1 What was added (local, read-only by construction)
`lib/storage/connectivity.ts` (three read-only request types only: `ListObjectsV2` with `MaxKeys=1`, `GetBucketCors`, `GetBucketLifecycleConfiguration`; fixed verdicts and error categories; errors are classified from names, codes and status numbers, never from messages), `scripts/check-r2-connection.ts` and `npm run r2:connect`. The script **sends nothing unless `RIO_CONFIRM_R2_CHECK=yes` is set for that one command**, builds the client with `maxAttempts: 1` (no automatic retry), gives each request a 15-second timeout, and prints only verdicts, counts and booleans. `createR2Client` gained an optional `maxAttempts`. Offline tests (27 in `lib/storage`, 11 new) check the exact commands and options sent, that an object name is never returned, that a failure is sent once, the failure categories, the CORS and lifecycle judgement, and that the module imports no write or object-read command.

### 21.2 Preflight (statuses and booleans)
All four R2 variables and the secret key are present and well formed in `.env.local`. The bucket in `.env.local` is the same as the dev-tooling bucket in `.env.live`, its name carries a dev or test marker and no production marker, the production `.env` defines no R2 variable, and the account is the same in both files. Credentials are server-only: no secret-looking `NEXT_PUBLIC_` name; the built client JavaScript (27 files) holds none of the five values or names and none of the connectivity code. `RIO_UPLOADS_ENABLED=no`. Registration closed (`event_settings` all null; 0 submissions; 0 video uploads).

### 21.3 Result of the single connection check
| | Result |
|---|---|
| Connectivity | **PASS** |
| Authentication | **PASS** (the credentials were accepted) |
| Bucket access | **PASS** (the token can list the bucket) |
| Objects returned (`MaxKeys=1`) | **0** (the bucket is empty) |
| Error category | none |
The captured output was scanned for account-id-like, key-like and URL-like text; the only match is the literal label "origin http://localhost:3100" of the CORS line (the expected value, not data).

### 21.4 Configuration review
| Item | Status | Basis |
|---|---|---|
| CORS (origin `http://localhost:3100`, method PUT, header Content-Type, exposed ETag, no wildcard) | **UNVERIFIED** | the read-only `GetBucketCors` was refused or not supported for this token; no CORS can be read without more access |
| Lifecycle: `pending/` deleted after 1 day | **UNVERIFIED** | same, for `GetBucketLifecycleConfiguration` |
| Private bucket | **UNVERIFIED** | the S3 API always requires signatures, so it says nothing about public access; needs the Cloudflare dashboard or API |
| Public `r2.dev` access disabled | **UNVERIFIED** | dashboard or API only |
| No public custom domain | **UNVERIFIED** | dashboard or API only |
| API token scoped to the development bucket | **UNVERIFIED** | the token can list the bucket; whether it can also reach other buckets was deliberately not tested (a bucket-listing call would expose other bucket names) |
Nothing was changed. These need either a look at the Cloudflare dashboard (R2, the bucket's Settings, and the API token's resources) or a separately approved token with read access to bucket configuration.

### 21.5 Postcheck
Uploads remain disabled. Supabase: all 25 earlier inspections are byte-for-byte equivalent to the M4A.3 post-migration snapshot (**no section changed**); registration settings, the six events, row counts (`audit_log` 114) and `video_uploads` (0 rows) are unchanged; no Supabase write ran. R2: the bucket reported 0 objects, and the only request types that can be sent are the three read-only ones, so no object was created or deleted. One transient pooler error ("Socket is closed") hit one read-only inspection in the first baseline attempt; the complete snapshot was re-taken and used. `lint`, `typecheck` exit 0; `npm test` **401 of 401** (23 files); `npm run build` exit 0; `npm run test:e2e` **74 of 74**; migrations 00100–00500 hash-identical (00500 prefix `321659c194f2f25d`).

### 21.6 Remaining integration blockers
1. Bucket privacy, `r2.dev`, custom domain, CORS, the `pending/` lifecycle rule and the token's scope are **UNVERIFIED** and must be confirmed in the Cloudflare dashboard before any upload test. CORS and the lifecycle rule are required for the upload to work and to clean up.
2. No write path to R2 has been exercised: the signed PUT, `HeadObject`, the conditional copy and deletion are UNVERIFIED. A first real test needs separate approval and `RIO_UPLOADS_ENABLED=yes` (with live registration test 7 updated or skipped).
3. Browser-only duration check; single PUT rather than multipart; M4B must re-HEAD the ETag at finalization; the Tamil copy needs review (D13).

**Result: PASS for connectivity, credentials and bucket read access; UNVERIFIED for bucket privacy and configuration.**

## 22. M4A.5 live upload preflight (2026-11-06)

**Scope kept:** read-only preflight and local preparation. No hosted write of any kind, no object written, no upload, no migration change, no registration opened, no production access, `RIO_UPLOADS_ENABLED` still `no`, nothing committed. The live test was written and loaded (`--list`) but **not run**.

### 22.1 Phase 1: read-only preflight
| Check | Result |
|---|---|
| Supabase target | dev ref `rajbfcoxolnjgiqgvflm` in `RIO_DEV_PROJECT_REF`, `RIO_LIVE_URL`, the app's URL and `RIO_SUPABASE_ALLOWED_REF`; pooler user `postgres.<ref>`, port 5432; production ref differs |
| R2 bucket | `R2_BUCKET_NAME` equals `rio-childrens-day-dev`; same bucket and account in `.env.local` and `.env.live`; no R2 variable in the production `.env` |
| Migration 00500 | applied (history 00100–00500) |
| Six events / settings / counts | all 25 inspections identical to the M4A.3 post-migration snapshot; registration closed (settings all null); 0 submissions; 0 `video_uploads`; 1 auth user (the banned dummy admin); `audit_log` 114 |
| Secrets | all five server settings present and well formed; no secret-looking `NEXT_PUBLIC_` name; none in the built client JS |
| Flag | `RIO_UPLOADS_ENABLED=no` in `.env.local`, unset in the shell |
| R2 connectivity (one more read-only check) | connectivity, authentication, bucket access **PASS**; 0 objects |
| **CORS** (credential-free browser-style preflights, no object touched) | **VERIFIED by behaviour:** origin `http://localhost:3100` is allowed exactly (not a wildcard) for PUT and the Content-Type header, with a max-age; another origin, the DELETE method and unlisted headers are **refused**. Exposing ETag is not visible on a preflight and the app does not read the PUT response's ETag (the server uses HeadObject), so it is not needed |
| Lifecycle (`pending/` after 1 day) | **UNVERIFIED**: the token cannot read bucket configuration (a least-privilege token), and there is no credential-free probe. It matters for abandoned objects; the test cleans up its own keys regardless |
| Public `r2.dev` URL disabled; no public custom domain | **UNVERIFIED**: needs the Cloudflare dashboard or API; the S3 endpoint always requires signatures, so it says nothing about public access. The user reports this was configured |
| Token scope (this bucket only; Object Read and Write incl. delete) | **UNVERIFIED**: it can list; write, copy and delete rights are proven only by the live test, and whether it reaches other buckets was deliberately not tested |
| Existing users and registrations | untouched by design: the test creates two new tagged users and one new entry, and deletes only those |

### 22.2 The prepared live test (`e2e-live/upload.liveupload.ts`, config `e2e-live/playwright.upload.config.ts`)
Run only as `RIO_LIVE_CONFIRM=<dev ref> RIO_LIVE_R2_CONFIRM=<dev bucket> npm run test:e2e:live:upload`. Four serial tests:
1. **Real parent, real UI:** sign in with the 8-digit code, register one dummy child, choose a synthetic file in the upload panel, upload. Checks: the browser PUT to the bucket succeeded (this proves CORS and the signed URL); the entry is `uploaded` with `video_key` equal to the object id (read with the parent's own session); the bookkeeping row is `verified` with the right size and an ETag; `videos/<id>` exists in R2 with the right size and type and `pending/<id>` is gone; "Submit entry" is disabled; the page HTML and console contain no signed-URL part, key, secret or address; the upload bookkeeping table is unreadable to both parents' sessions.
2. **Security with the real database and bucket:** Parent B cannot start an upload for A's entry and cannot finish A's upload (the same answer as for an id that does not exist); A cannot reuse the finished authorization; a backdated authorization is refused as expired; malformed ids are refused; in every case **the R2 call counters do not move** (R2 never contacted); no result contains a URL, key, bucket, account or address.
3. **Overwrite and content type:** re-using the first (used) URL only reaches `pending/`, and `videos/<id>` keeps the same ETag and size; a PUT with a different Content-Type is recorded as a finding (refused by the bucket, or accepted and then rejected and deleted by the server's HeadObject type check).
4. **Closed registration:** after the window is closed no authorization is issued and nothing is signed.
**Payload:** a silent 31-second WAV clip labelled `video/mp4` (no ffmpeg here). It exercises size, type, duration reading and the whole storage path but is **not a real MP4 file**; a MediaRecorder WebM clip is the alternative if a real container is wanted.
**Uploads are switched on only for the web server the test starts** (`webServer.env`), never in `.env.local` or the test process. The Content-Security-Policy is fixed at build time, so the run builds into a separate directory (`.next-upload-test`, via `RIO_DIST_DIR`) whose policy names the bucket host; the normal `.next` build still has none (checked: 1 mention versus 0).

### 22.3 Phase 3: safety review
- **Guards before anything starts:** the config calls `assertUploadTarget` before it builds or starts a server: `RIO_LIVE_R2_CONFIRM` must equal the bucket name, the name must look like a dev bucket and not like production, the switch must not already be on in the test process, and all settings must exist. Plus the existing Supabase guard (`RIO_LIVE_CONFIRM` = dev ref, production refused). Messages are fixed strings.
- **Cleanup:** computed by `planCleanup` from the bucket listing before and after the run. It deletes only `pending/<id>` and `videos/<id>` for ids this run created (read from the database and the intercepted URLs), re-checks each with `isTrackedKey`, never touches an object that existed before, and reports (never deletes) any other new object. The only `remove` call in the file takes a key from that plan. It runs in `afterAll` even when a test fails, each step in its own try block with fixed labels, so one failure does not stop the rest; it then verifies the bucket, restores the exact settings, deletes the entry, the upload rows (cascade) and the two users, and checks the counts against the baseline. If the baseline was not captured it deletes no object.
- **R2 writes** all use the single configured bucket (no hard-coded name anywhere; tested). Authorization is required before any R2 operation on confirmation (M4A.1).
- **Logs:** the spec has no `console` call; assertions compare booleans so a failure message cannot carry a URL, email or code; Playwright records no trace, screenshot or video and uses the line reporter. A failed run leaves `test-results` (an error-context page snapshot may contain the dummy email): delete it after the run.
- **No accidental runs:** the registration live config matches only `*.live.spec.ts`, the upload config only `*.liveupload.ts`; the registration suite throws if `RIO_UPLOADS_ENABLED=yes`; the upload server never reuses an existing one (port 3100 must be free).
- **Side effect handled:** `next build` rewrites `tsconfig.json` and `next-env.d.ts` for the extra directory (seen in a local trial and repaired). The run therefore goes through `scripts/live-upload-run.mjs`, which saves both files first and restores them and deletes `.next-upload-test` however the run ends (tested with a simulated mutation and a failing child).

### 22.4 Offline results
`lint` and `typecheck` exit 0; `npm test` **421 of 421** (24 files; 31 new in `scripts/live-upload.test.ts`, covering the guards, key tracking, the cleanup plan, the synthetic clip, leak detection and the wiring); the whole suite on Postgres 17 also 421 of 421; `npm run build` exit 0; `npm run test:e2e` **74 of 74**. Mutation checks: treating every key as ours failed 3 tests, deleting pre-existing objects failed 2, accepting any bucket name failed 1; the file was restored byte-identical. The config and spec load with `--list` (4 tests) and refuse without the bucket confirmation or with uploads already on.

### 22.5 What the live run needs (for approval)
**Supabase dev writes:** 2 auth users (created, then deleted); `event_settings` opened for 30 minutes then restored (and set closed once for test 4); 1 submission with its audit rows; about 4 `video_uploads` rows (cascade-deleted with the entry); roughly 20 new append-only `audit_log` rows that cannot be removed. **R2 writes (this bucket only):** one browser PUT to `pending/<id>`; one server-side copy to `videos/<id>`; deletes of exactly the tracked keys; up to 2 more small PUTs for the negative cases. Reads: HeadObject and ListObjectsV2. **Process-level:** the two typed confirmations for that one command; uploads on only in the test's server; a free port 3100; a local production build into `.next-upload-test` (about a minute). **Expected leftovers:** only the audit rows; if the token cannot delete, up to two small test objects (the cleanup reports it and the lifecycle rule, if present, would clear `pending/`).

### 22.6 Remaining blockers
1. A separate approval of this exact plan for ONE live run.
2. Confirm in the Cloudflare dashboard: the `r2.dev` public URL is off, no public custom domain, and the token is limited to this bucket with Object Read and Write (including delete). Optionally the `pending/` lifecycle rule (not required for the test).
3. The test has never run live: a first run may reveal a problem (for example the token cannot copy or delete); cleanup is designed for partial failure and its planner is unit-tested, but the end-to-end behaviour is unproven.
4. Browser-only duration check, single PUT, M4B ETag re-check, Tamil copy review, live registration test 7 expects uploads off.

**Verdict: READY for one controlled live test with a synthetic payload, subject to the approval above. NOT yet ready for any real child's video** until the dashboard items in blocker 2 are confirmed.

## 23. M4A.5 controlled live upload run: one execution, failed at provisioning (2026-11-06)

**Authorization:** one execution of the reviewed four-test live upload suite against the dev Supabase project and the dev R2 bucket. It was run **once**; nothing was retried, the application was not changed after the run, and no migration, RLS, production or unrelated hosted resource was touched. Uploads were switched on only in the suite's own server process; `.env.local` still says `RIO_UPLOADS_ENABLED=no`.

### 23.1 Changes made before the run (as required)
- The WAV file labelled `video/mp4` was **replaced by a genuine video**: `e2e-live/media.ts` records an animated canvas (a changing colour with a frame counter; no person, child, voice or personal data) in the test's own Chrome with MediaRecorder (WebM, VP9), then loads it back into a `<video>` element and proves it **decodes, has the expected length and a 320x240 picture, and really plays**. `mediaProblems()` is the acceptance gate and runs **before any Supabase or R2 call** in `beforeAll`; the upload panel's own duration reader must show the same whole number of seconds. A single-part R2 ETag is the MD5 of the stored bytes, so the run also compares the stored ETag with the file's MD5 (recorded as a finding) without downloading anything. Offline dress rehearsal of the 31-second recording: **VP9, 30.96 s, 320x240, 456,333 bytes, played, correct EBML header**.
- An offline browser test (`e2e/webm-generator.spec.ts`, 6-second clip; shorter clips are unreliable because the first recording of a fresh browser can take seconds to produce data) keeps the generator honest. An unrelated afterAll nuisance was also fixed (no cleanup complaint when nothing was created).
- **Server-side media validation does not exist and is not claimed.** HeadObject verifies size, the type header and the ETag only. An offline test now documents that any bytes with matching metadata are accepted and that the upload code contains no media probe (`ffprobe`, `mediainfo`, object reads). A passing live run would not have been evidence of media authenticity.
- Offline results after the changes: `lint`, `typecheck` exit 0; `npm test` **424 of 424** (also on Postgres 17); build exit 0; browser tests **75 of 75**; migrations hash-identical (00500 prefix `321659c194f2f25d`).

### 23.2 Mandatory preflight (all passed before anything was written)
Supabase dev ref consistent everywhere and separate from production; R2 bucket equals `rio-childrens-day-dev`, no R2 variable in the production `.env`; migration 00500 applied; registration closed (settings all null); `RIO_UPLOADS_ENABLED=no`, confirmations not set in the shell. **Baseline:** 1 auth user (the banned dummy admin), 0 submissions, 0 upload rows, **0 objects in the bucket**, 114 audit rows, six events hash `e056688e3a9568ee`. Dashboard configuration (public `r2.dev` off, no custom domain, bucket-scoped token, exact-origin CORS, `pending/` lifecycle) rests on your report; the only independent evidence is behavioural and does **not contradict** it (a credential-free CORS probe: the exact origin allowed for PUT and Content-Type, another origin, DELETE and unlisted headers refused). Exact-key cleanup and its guards were re-verified by unit and mutation tests.

### 23.3 Result of the single run: FAILED at provisioning, 0 of 4 tests ran
| | |
|---|---|
| Stage | the suite's `beforeAll` hook (provisioning), at the creation of the **second dummy parent's** session |
| Message | "beforeAll hook timeout of 240000ms exceeded", with the underlying error "could not start a user session: fetch failed" (a network error reaching Supabase Auth to verify the generated code) |
| Passed before the failure | the genuine video was generated and accepted by the gate; the bucket baseline was read; two dummy users were created; the temporary registration window was opened; the **first** parent's session was started |
| Tests | 1 failed (the hook), **3 did not run**; no browser step, no registration, no upload authorization, **no object write** (the bucket was only listed) |
| Cause | not determined from the output. It looks like a transient network failure or stall between this machine and Supabase Auth; a read-only health request to the same service moments afterwards answered 200 in about 150 to 500 ms, so the service was reachable again. No application, storage or CORS step was reached |
Per the failure policy there was no retry and no change.

### 23.4 Cleanup (verified independently, read-only, after the run)
`afterAll` ran and succeeded: the two dummy users are gone (the only auth user is again the banned dummy admin); `event_settings` is back to all null (registration closed); 0 submissions; the six events have the identical hash; **the bucket still holds 0 objects (baseline 0)**; the dummy admin and its role are untouched. **Residue: 2 new append-only audit rows (114 to 116), both on `event_settings` (the window opened and restored).** The wrapper restored `tsconfig.json` and `next-env.d.ts` (hash-identical to before) and removed `.next-upload-test`; the failed run's `test-results` was deleted. `RIO_UPLOADS_ENABLED=no` in `.env.local`; the two confirmation variables were set for that one command only and are not set in the shell.

### 23.5 Verification list status
Every item on the live list is **UNVERIFIED** (not reached): parent OTP sign-in through the app in this run, registration through the UI, the browser upload and presigned PUT, CORS in a real browser upload, HeadObject and the conditional copy against R2, the Supabase attachment, removal of the pending object, the disabled final-submission button, cross-parent isolation against the real database and bucket, expired and reused authorizations, zero R2 calls for unauthorized requests, the old-URL re-PUT, the content-type finding, and closed-registration blocking. Preflight facts that were verified live: connectivity, credentials, bucket read access, exact-origin CORS behaviour.

### 23.6 Remaining blockers
1. A **new explicit approval** is needed for any further live run (this one was for exactly one execution).
2. Before a re-run it would be sensible to make provisioning more tolerant (a longer hook timeout, for example 360 s, and failing fast with a clear message if Supabase Auth does not answer a health request, so a stalled network does not spend the whole timeout), and to confirm the network is stable. These are test-harness changes only, not application changes.
3. Still UNVERIFIED against real services: the signed PUT, HeadObject, the conditional copy and deletion, and the token's write and delete rights.
4. The dashboard items (public `r2.dev` off, no custom domain, bucket-scoped token, `pending/` lifecycle) remain unverified by me; the lifecycle rule cannot be read with this token.
5. Browser-only duration check; no server-side media inspection; single PUT; M4B must re-HEAD the ETag at finalization; the Tamil copy needs review.

**Result: FAIL (provisioning), cleanup verified clean; real upload UNVERIFIED.**

## 24. M4A.5 live-suite provisioning hardened, awaiting a new approval (2026-11-06)

**Scope kept:** harness-only changes (test files and test helpers). No application code, migration, RLS, Supabase, R2 or production change; **no live run was made**; `RIO_UPLOADS_ENABLED` is still `no`; nothing committed.

### 24.1 What changed (response to the §23 failure: "fetch failed", then the whole hook ran out of time)
- **Every Supabase request the live suites make is bounded** (30 s) through `timeoutFetch` in `e2e-live/helpers.ts` (the secret-key client and the user-session client), so a stalled network fails one request quickly instead of hanging the hook. The R2 baseline listing carries a 30 s abort signal and each cleanup deletion is wrapped in a 30 s `withTimeout`.
- **Fail fast before any write:** after the test video is generated and accepted, the hook makes **one harmless GET of Supabase Auth's public health endpoint** (`authHealth`). Anything but a healthy answer stops the run with the message "Supabase Auth is not answering ... nothing was written", before any user, setting or object is created.
- **Named stages:** provisioning is a sequence of named stages (generate the video, read the baselines, create parent A, create parent B, open the window, start each parent's session). A failure now reads `provisioning failed at stage "<name>" (<error type>)`; the original text is dropped because it can contain a URL.
- **Generous limits:** the setup and cleanup hooks allow 360 s (was 240 s); the per-request bounds make the worst case about 245 s.
- **Tests (offline):** timeout abort and pass-through, an already-aborted caller signal, the health verdicts (healthy, unhealthy, unreachable, a stall counts as unreachable) and that exactly one GET of the health path is made, stage message hygiene, `withTimeout`, and static checks that the helpers bound both clients, the health check precedes the first write, the condition that stops the run is present, and the hook names its stages. Mutation checks: removing the stop condition, unbounding the clients and shortening the hook timeout each fail a test (the first only after its assertion was strengthened); files restored byte-identical.

### 24.2 Results
`lint` and `typecheck` exit 0; `npm test` **430 of 430** (24 files), also on Postgres 17; `npm run build` exit 0; migrations hash-identical (00500 prefix `321659c194f2f25d`); the live config and spec still load with `--list` (4 tests); `tsconfig.json` and `next-env.d.ts` unchanged; no leftover build directory, `test-results` or confirmation variable; `.env.local` still `RIO_UPLOADS_ENABLED=no`.
**Browser tests: not cleanly green after these changes, for environmental reasons.** They were 75 of 75 in about 31 s before the live run. Three re-runs after the hardening took 3.6 to 4.8 minutes and failed between 1 and 10 tests (page-load timeouts in the smoke and upload-panel tests, and "the recorder produced no data" in the video-generator test). No application code changed in between; the harness files changed are not imported by those tests apart from a type import. At the time the machine was saturated: CPU load 97 % from desktop applications (Edge, Discord, other programs), about 2.2 GB of 15.8 GB memory free, and a plain `GET /` on the local production server took 2 to 9 seconds. With 2 workers instead of 5, 74 of 75 passed (the generator test failed). **Re-run the browser suite when the machine is quiet.**

### 24.3 What this means for a second live run
- The same load problem could hurt it: the 31-second recording can come out short or empty on a saturated machine (the acceptance gate would stop the run **before** any hosted write), and Supabase calls may be slow. Close heavy applications first and make sure the network is stable.
- A second live run needs a **new explicit approval** (the previous approval was for exactly one execution). Nothing else has changed from §22 and §23: same plan, same four tests, same exact-key cleanup, same confirmations (`RIO_LIVE_CONFIRM` = dev ref, `RIO_LIVE_R2_CONFIRM` = dev bucket name, for that one command).
- Still unverified against real services: the signed PUT, HeadObject, the conditional copy and deletion, and the token's write and delete rights. The dashboard items (public `r2.dev` off, no custom domain, bucket-scoped token, `pending/` lifecycle) rest on the user's report.

**Result: hardening complete and tested offline; waiting for approval. No hosted action was taken in this step.**

## 25. M4A.5A final offline verification (2026-11-06)

**Scope kept:** no live Supabase provisioning, no R2 upload or delete, no migration, no commit, push or deployment. Hosted resources were only read (to prove they did not change).

### 25.1 Browser tests: what actually happened
No complete passing run of the whole browser suite happened after the hardening, and none is claimed. Before the live run it was **75 of 75** (about 31 s). After the hardening it was run three times, while the machine was saturated (CPU about 97 % from desktop applications, about 2.2 GB of 15.8 GB memory free, a plain page load on the local server taking 2 to 9 s):
| Rerun | Workers | Result | Time | Failing tests |
|---|---|---|---|---|
| 1 | 5 | 69 passed, 6 failed | 3.7 min | 5 smoke tests (30 s page-load timeouts) and the video generator |
| 2 | 5 | 65 passed, 10 failed | 4.8 min | sign-in tests (some timed out while the browser page was still being set up), upload-panel tests (30 s timeouts), and the video generator |
| 3 | 2 | 74 passed, 1 failed | 3.6 min | only the video generator |
**Explanation.** The page-load, sign-in and upload-panel failures were different tests each time, hit 30 s timeouts (several before the test body even started), shrank from 10 to 1 as parallelism fell, and no application code changed between the green run and these runs. They are infrastructure slowness. The video-generator failure was the same in all three reruns and was investigated separately (25.2).
**Targeted runs after the machine calmed down (CPU about 9 to 25 %), with the exact counts:**
- generator test + 31-second rehearsal + all smoke tests: **19 of 19 passed** (54.8 s). Every smoke test took 61 to 852 ms (9.1 s for all 17), against the 30 s timeouts seen under load.
- sign-in (`auth.spec.ts`) + upload panel (`upload-panel.spec.ts`): **40 of 40 passed** (1.2 min, 2 workers).
- By spec, every file has now passed after the hardening: smoke 17, generator 1, sign-in plus upload panel 40, registration form 10 and OTP form 7 (the last two passed in all three reruns). That sums to 75, but across several runs, so it is **not** a single complete run. A clean single run of the whole suite on a quiet machine is still outstanding.

### 25.2 The 31-second WebM generator
On a quiet machine a fresh browser delivers its first recorded chunk after about 1.4 s (cold) and 1.0 s (warm). Under load the encoder's start-up exceeded the short test clip and the recording came out empty ("the recorder produced no data"). **Fix (test helper only, `e2e-live/media.ts`):** a short warm-up recording first, waiting up to 30 s for the first chunk and discarding it, so the real recording starts with a running encoder; if nothing arrives within 30 s it fails with "the recorder produced no data within 30 s (is the machine too busy?)", always before any hosted call. No timeout was raised. Results: the generator test passes (9.4 s); the **31-second rehearsal** with the real acceptance gate passed: **VP9 WebM, 30.97 s, 320x240, 546,787 bytes, decoded and played, valid EBML header**, no problems, 33 s to produce. One more static test guards the warm-up. The one-off rehearsal and probe files were deleted.

### 25.3 Provisioning hardening (re-verified, from §24)
Every Supabase request in the live suites has a 30 s timeout; the R2 baseline listing has an abort signal and each cleanup deletion a 30 s bound; one harmless GET of Supabase Auth's health endpoint precedes the first write and stops the run if it is not healthy; provisioning is in named stages whose failure messages carry no URL or text from the original error; the setup and cleanup hooks allow 360 s. Mutation checks (removing the stop condition, unbounding the clients, shortening the hook timeout) each fail a test. Signatures checked again at the end: the stop condition is present once, there is no `if (false)` in the live files, both Supabase clients are bounded, both hooks have the 360 s limit, the cleanup still requires a tracked id and skips pre-existing objects, the bucket guard still refuses a non-dev-looking name, the uploads switch is still the exact-"yes" test and both server actions still check it first. The live spec and helpers are byte-identical to the copies saved before the mutation checks.

### 25.4 Verification
`lint` and `typecheck` exit 0; `npm test` **430 of 430** (24 files), and the same on Postgres 17 (the generator warm-up assertion then brought `scripts/live-upload.test.ts` to 28 tests and the whole unit suite to 431; that file re-passed 28 of 28); the live config and spec load with `--list` (4 tests) and leave `tsconfig.json` and `next-env.d.ts` unchanged. `RIO_UPLOADS_ENABLED=no` in `.env.local`, unset in the shell, and no live or R2 confirmation variable is set. No `zz-` rehearsal or probe file, no `test-results`, no `.next-upload-test`. Migrations 00100–00400 hash-identical and 00500 unchanged (prefix `321659c194f2f25d`). **Hosted state, read-only:** registration settings all null (closed); 1 auth user (the banned dummy admin); 0 submissions; 0 `video_uploads`; 0 objects in the bucket; `audit_log` 116; the history is 00100–00500; the whole read-only snapshot is identical to the one taken right after the failed live run, so nothing hosted changed since.

### 25.5 Remaining risks
1. **No single complete passing browser run exists after the hardening**; rerun the whole suite once when the machine is quiet.
2. A second live run needs a **new explicit approval**. The same load problem could hit it (a saturated machine or network); the new gates fail closed before any hosted write, but close heavy applications first.
3. Still unverified against real services: the signed PUT, HeadObject, the conditional copy and deletion, the token's write and delete rights, and the stored object's integrity in a real browser upload. Dashboard items (public `r2.dev` off, no custom domain, bucket-scoped token, `pending/` lifecycle) rest on the user's report.
4. The server verifies metadata only; no media inspection exists. Browser-only duration check; single PUT; M4B must re-check the ETag at finalization; Tamil copy review.

**Verdict: READY for a second live run once approved and on a quiet machine. Not started.**

## 26. M4A.5B second controlled live upload run: PASS (2026-11-06)

**Authorization:** one more execution of the reviewed four-test live upload suite against `rio-childrens-day-dev` (ref `rajbfcoxolnjgiqgvflm`) and the R2 bucket `rio-childrens-day-dev`, conditional on an offline gate. It was run **once**; nothing was retried; the application, migrations and permissions were not changed; no production resource was touched; nothing was committed.

### 26.1 Phase 1: offline gate (passed before anything hosted was touched)
Machine quiet (CPU 12 to 25 %, about 5 GB free). `lint` and `typecheck` exit 0; unit tests **431 of 431**; `RIO_UPLOADS_ENABLED=no`; migrations 00100–00400 hash-identical and 00500 unchanged (prefix `321659c194f2f25d`). **The COMPLETE browser suite, run once with 2 workers and no retries: 75 of 75 passed in 57.8 s** (this is the clean single full run that §25 lacked). The real WebM generator test is among them.

### 26.2 Phase 2: live preflight (all passed)
Dev ref consistent everywhere and separate from production; bucket equals `rio-childrens-day-dev`; no R2 variable in the production `.env`; migration 00500 applied; registration closed (settings all null); 0 submissions, 0 `video_uploads`; the only user is the banned dummy admin; **0 objects in the bucket**; audit log 116 rows; the six events hash `e056688e3a9568ee`; Supabase Auth health 200 in 180 to 523 ms before any write; a credential-free CORS probe still shows the exact origin allowed for PUT and Content-Type and refuses another origin, DELETE and unlisted headers (so nothing contradicts the dashboard configuration you reported; the lifecycle rule, the `r2.dev` URL, the custom domain and the token scope still cannot be seen from here).

### 26.3 Phase 3: result of the single live run: 4 passed, 0 failed, 0 skipped (1.8 min)
| # | Test | Result | What it asserted |
|---|---|---|---|
| 1 | a real parent uploads one video through the app | **PASS** | Parents A and B both started real Supabase sessions from generated 8-digit codes; A signed in through the real app screen; one dummy child registered through the real form (draft saved); a genuine 31-second WebM, already decoded and played in Chrome before any hosted call, was chosen in the upload panel, whose own duration reader agreed with the generator; the **browser PUT to the bucket succeeded** (2xx; this proves CORS and the signed URL); the entry became `uploaded` with `video_key` equal to the object id (read with the parent's own session); the bookkeeping row is `verified` with the right size and an ETag; `videos/<id>` exists in R2 with the right size and type and **`pending/<id>` is gone**; "Submit entry" is **disabled**; the page HTML and console hold no signed-URL part, key, secret or address; both parents' sessions cannot read the upload table |
| 2 | another parent cannot use or probe the upload | **PASS** | Parent B cannot start an upload for A's entry and cannot finish A's upload (the same answer as for an id that does not exist); A cannot reuse the finished authorization; a backdated authorization is refused as expired; malformed ids are refused; **in every case the R2 call counters did not move** (R2 never contacted); no answer contains a URL, key, bucket, account or address |
| 3 | the verified video cannot be replaced through the old URL; content type observed | **PASS** | re-using the first (already used) PUT URL did not change `videos/<id>`: its ETag and size were identical afterwards; a PUT with a different Content-Type was handled (see 26.5) |
| 4 | closed registration blocks new uploads | **PASS** | after the window was closed no authorization was issued and nothing was signed |
The append-only audit log confirms the sequence without exposing ids: authorization #1 issued then verified; the entry draft then uploaded; authorization #2 issued, backdated, superseded by authorization #3; authorization #3 issued and never changed afterwards; the window opened, closed once for test 4, and restored.

### 26.4 What is and is not proven
- **Proven live:** real parent OTP sessions; registration through the real UI; a real browser upload to private R2 over CORS with a presigned URL; HeadObject metadata (size and type) matching the declaration; the conditional copy to `videos/<id>`; removal of `pending/<id>`; the database attachment of exactly that object id to the right entry; no finalization; cross-parent isolation; expired and reused authorizations refused; zero R2 calls for every unauthorized request; protection of the verified video from the old URL; closed registration; no leak of URLs, keys or addresses; the token can list, put, copy and delete in this bucket (all four happened, and cleanup deleted by exact key).
- **NOT proven, and not claimed:** **HeadObject verifies stored metadata, not the media.** The server does not inspect the container, codec or duration (no probe exists); the genuine WebM passed because the test made a genuine one, not because the server checked. Server-side media inspection remains a separate requirement. The duration check is browser-only.

### 26.5 Security findings
1. **Signed Content-Type: the bucket refused the mismatched PUT.** The third authorization has no status change in the audit log; had the bucket accepted a PUT with another Content-Type, the server would have rejected it at confirmation (`issued -> rejected`) and an entry would exist. None does, and the test would have failed on any exception, so the PUT received a non-2xx answer. (Inferred from the audit log, because the annotation below was lost.)
2. **Harness gap:** the findings the test records as annotations (the status of the old-URL re-PUT, whether the stored ETag equals the file's MD5, and the media facts) are **not printed by the `line` reporter**, so they were not captured this time. What is proven is the assertion that passed: `videos/<id>` was unchanged. Add a reporter that prints annotations before any further live run, if those numbers matter.
3. The server's check is metadata-only (26.4). 4. The bookkeeping table is unreadable to parents (asserted). 5. The in-memory rate limiter is per instance.

### 26.6 Phase 4: cleanup (verified independently, read-only)
The two dummy users are gone (the only auth user is the banned dummy admin); `event_settings` all null (registration closed); 0 submissions and 0 `video_uploads`; the six events have the identical hash; **the bucket holds 0 objects, equal to the baseline**; `tsconfig.json` and `next-env.d.ts` identical to before; `.next-upload-test` and `test-results` removed; `RIO_UPLOADS_ENABLED=no` in `.env.local` and unset in the shell; both live confirmation variables were set for that one command only and are not set now; a read-only snapshot differs from the baseline only in the audit-log count. **Residue: 12 new append-only audit rows (116 to 128):** `event_settings` 3, `submissions` 3 (insert, draft to uploaded, the cleanup delete), `video_uploads` 6. Nothing else remains; nothing could not be cleaned.

### 26.7 Remaining blockers and next steps
1. **M4B** (final submission with the ETag re-check against R2) and playback (M5) are not started.
2. Server-side media inspection, a multipart and resumable upload for weak mobile networks, and the abandoned-object cleanup job are open (the job exists but was not run live).
3. Dashboard items still resting on the user's report: public `r2.dev` off, no public custom domain, bucket-scoped token, `pending/` lifecycle rule.
4. Turning uploads on for real use is a separate, deliberate step (`RIO_UPLOADS_ENABLED=yes`, with live registration test 7 updated), as are the Tamil copy review and the legal review of the consent wording.

**Result: PASS.**

---

## 27. M4B.1 final video submission: offline implementation (2026-11-06)

**Scope kept:** local implementation and offline tests only. No hosted Supabase write, no real R2 operation, **migration 00600 is written but NOT applied anywhere**, no production access, no commit, push or deployment. M5 not started. Final submission is **OFF** (`RIO_FINALIZE_ENABLED=no`) and uploads stay **OFF** (`RIO_UPLOADS_ENABLED=no`).

### 27.1 What existed (Task 1: inspection)
- The `submissions` state machine already had `draft → uploaded → finalized` plus `withdrawn`; a guard trigger enforces the allowed moves and locks a finalized row; the partial unique index `submissions_one_finalized_per_child` (normalized mobile + child name) already enforces one finalized entry per child; the audit trigger records status changes (ids and states only). **No new status was needed.**
- **Security finding:** the old `public.finalize_submission(id)` was executable by any signed-in parent straight from the API. It checked ownership and the window but **never looked at the R2 object**. A parent could have finalized an entry whose stored video had been replaced after verification. M4B closes this by removing that function.
- Guardian consent is recorded at registration (`consent_version`, server-set timestamp) and is mandatory; the optional media permission is a separate flag that is **not** a condition of entering.

### 27.2 Submission state transitions
| From | To | By | Conditions |
|---|---|---|---|
| draft | uploaded | `attach_video_upload` (M4A, service role) | verified upload of this entry and owner |
| uploaded | **finalized** | `finalize_verified_submission` (service role only) | all of 27.4 |
| finalized | finalized | same function | answered `already_finalized`; nothing changes, timestamp unchanged |
| finalized | anything | nobody | trigger: locked (edit, withdraw, new upload all refused) |
| draft, uploaded | withdrawn | parent (M2) | unchanged |
Nobody (parent, judge, admin, anon) can write `status` directly; a test tries each.

### 27.3 Database migration requirement
`supabase/migrations/20261105000600_final_submission.sql` (**prepared, not applied; needs the owner's approval to apply to DEV**):
1. `drop function public.finalize_submission(uuid)`.
2. `check_finalize(owner, submission)`: read-only; returns the verified record (upload id, size, type, ETag, competition, consent version, `already`). Refuses: not the owner's or missing (identical answer), wrong status, window closed, no video, video not verified, no consent record. Returns `already = true` for an entry that is already final, even after the window closes.
3. `finalize_verified_submission(owner, submission, upload, bytes, type, etag)`: the one atomic transition. Locks the submission then the upload row (same order as attach), repeats every check, compares the supplied current size, type and ETag with the verified record (`video_changed`), maps a duplicate child to `duplicate_entry` (23505), returns `finalized` or `already_finalized`.
Both are `security definer`, `search_path = ''`, `revoke all` from public/anon/authenticated, `grant execute` to `service_role` only. Migrations 00100–00500 are untouched (hashes verified: 00400 prefix `8c995be9d66de368`, 00500 prefix `321659c194f2f25d`; 00600 prefix `539ae80ea433ea86`). `supabase/recovery/rollback_m2_dev_only.sql` knows the new functions and version.

### 27.4 Finalization security design
Order in `lib/submit/service.ts` (`finalizeEntry`), called only by the server action:
1. `RIO_FINALIZE_ENABLED` exact `yes` is the **first statement** of the action, before even a session lookup; it is also enforced in the page (`submitStep`) and in the dependency builder. It is separate from the upload switch.
2. The parent comes from `auth.getUser()` (verified with Supabase), never from the request. Unsigned or expired session: "not found", before any database or bucket call.
3. The competition comes from the page's slug; an entry of another competition is "not found". Rate limit 5 per parent per 10 minutes.
4. **Authorize in the database first** (`check_finalize`). Everything the database can refuse is refused **before R2 is contacted** (tests assert zero bucket calls). Another parent's entry is indistinguishable from a missing one.
5. Consent version must be one the app recognises.
6. **HeadObject** on `videos/<upload id>`; the key comes from the database record, never the browser. Missing object, or size, content type or ETag different from the verified record, is refused. A bucket failure is a plain "unavailable" and changes nothing.
7. The atomic transition repeats steps 4 and 6's comparison under row locks, so a change between the bucket check and the transition (or two requests at once) cannot slip through. A second request is answered `already`.
Results contain no object key, ETag, URL, secret or child detail; nothing in this path logs (asserted by a static test). The browser never sees R2 credentials or any key; there is still no public playback URL.

### 27.5 Media inspection (Task 3): recommendation and the release blocker
**What is and is not proven.** An unchanged ETag, size and type prove only that the **bytes are the ones that were verified**. They do not prove the file is a playable video, which codec it uses, or that it is 30 to 90 seconds. Today the duration is checked only in the parent's browser (which a determined user can bypass).
**Options, bounded and compatible with Vercel and private R2:**
1. *Recommended first step: ranged-GET container sniff in the finalize request.* Read at most a few MiB with `Range` requests (head, and for MP4/MOV the `moov` box wherever it is): check EBML/`ftyp` magic, read the duration from the header (WebM `Segment/Info/Duration`, MP4 `mvhd`), reject mismatches with the declared type, enforce 30 to 90 s with a small tolerance. Needs no new infrastructure and no transcoding, fits a serverless function. Limits: it trusts headers, and a file with a valid header and garbage body passes; MP4 with `moov` at the end needs a second ranged read.
2. *Stronger:* an `ffprobe` worker outside Vercel (a small container or job) that reads the object through a short-lived presigned GET and returns facts. Better truth, but new infrastructure, so not done without approval.
3. *Not recommended now:* transcoding or thumbnailing (cost, latency, new cloud service).
**Decision: not implemented in M4B.1 (the brief said not to add expensive processing or new infrastructure). This is release blocker B1: public finalization stays disabled (`RIO_FINALIZE_ENABLED=no`) until option 1 (at minimum) exists and is tested against real files of each accepted type.**

### 27.6 Parent interface (Task 4)
- "Submit entry" is a working button only for an **uploaded** entry while registration is open and the switch is on; otherwise it is the disabled button labelled "Not open yet". Drafts without a video never see it enabled.
- Clicking it opens a review (heading receives focus): competition, child name and age, the plain statement that submitting is final and the entry and video cannot be changed afterwards, then "Yes, submit my final entry" and "Go back". Escape goes back; focus returns to the opener.
- The confirm button is disabled and shows "Submitting…" while the request runs; a ref guard rejects a second click before the screen updates (browser test: a double click plus repeated Enter send exactly one request).
- Success shows a status message ("Entry submitted", saved status "Submitted") and the page refreshes into a read-only summary (`SubmittedPanel`: status, competition, child, date, winners 14 Nov 2026). The draft list shows "Submitted". There is no edit path for a finalized entry.
- Every failure code has a bilingual message and a "Try again" button; an unknown code shows the plain "unavailable" text, never the code.
- The optional media permission is shown as information only ("not needed to enter" / "your child can still enter"); there is no checkbox and nothing implies it is required. Guardian consent stays mandatory at registration.
- Tamil text is **provisional** (D13). The date format was corrected during testing to the project's `5 நவம்பர் 2026 / 5 Nov 2026` (the Tamil locale inserts a comma).

### 27.7 Files changed
New: `supabase/migrations/20261105000600_final_submission.sql`; `lib/submit/service.ts`, `lib/submit/server.ts`; `app/events/[slug]/register/submit-actions.ts`; `lib/registration/date.ts`; `components/registration/submit-entry.tsx`, `submitted-panel.tsx`; tests `lib/submit/service.test.ts`, `lib/submit/server.test.ts`, `app/events/[slug]/register/submit-actions.test.ts`, `lib/registration/submit-copy.test.ts`, `supabase/tests/finalize.test.ts`, `supabase/tests/finalize-flow.test.ts`, `e2e/submit-entry.spec.ts`, `e2e/fixtures/fake-submit-actions.ts`, `e2e/fixtures/submit-entry.tsx`.
Changed: `lib/registration/messages.ts` (new `submit` block; `nextSteps.soon` now "Not open yet"), `components/registration/next-steps.tsx`, `draft-list.tsx`, `app/events/[slug]/register/page.tsx`, `lib/registration/drafts.ts`, `.env.example` (documents `RIO_FINALIZE_ENABLED`), `supabase/recovery/rollback_m2_dev_only.sql`, `supabase/tests/helpers.ts` (`uploadVerified`), `migrations.test.ts`, `access.test.ts`, `constraints.test.ts` (old finalizer now gone), `lib/upload/boundary.test.ts` (final submission has exactly one path), `e2e/upload-panel.spec.ts` (also stubs the submit action). Git-ignored `.env.local` gained `RIO_FINALIZE_ENABLED=no`.

### 27.8 Tests (Task 6), all offline, mocked R2 and an in-memory test database
| Check | Result |
|---|---|
| `npm run lint`, `npx tsc --noEmit` | exit 0, no output |
| `npm test` (Postgres 18) | **513 of 513** (was 431) |
| `npm run test:pg17` (Postgres 17) | **513 of 513** |
| Full browser suite, 2 workers, no retries | **101 of 101** (was 75; 26 new for the submit step) |
| `npm run build` | passes |
Covered: valid submission; missing video; missing or unknown consent; another parent's entry (same answer as a missing one); wrong or superseded upload; missing R2 object; changed ETag, size or type (in the service, in the SQL, and between the check and the transition); window closed (also after the video is verified); duplicate child across parents and competitions; two simultaneous requests; repeated submission (idempotent, no second bucket request, timestamp unchanged); expired or missing session; database failure at the transition (nothing leaked, nothing changed); HeadObject failure (then a retry succeeds); the old finalizer gone; no one can write `status`; service-role-only execution; the switch (every near-miss spelling is OFF) and the action's order; audit rows hold no personal data; browser: confirmation and final warning, Go back and Escape, one request on double click, success, all 13 failure codes, dropped connection and retry, Tab order and Enter, 360 px with no horizontal scroll and 44 px targets, media wording, disabled when off.
**Mutation checks** (a deliberate break must fail a test; all restored afterwards): switch always on; switch accepts any non-empty value; builder ignores the switch; action skips the availability check; ETag, size not compared; bucket asked before the database; already-final still asks the bucket; competition not matched; submit step offered for drafts; SQL ETag and content type comparisons removed. **10 of 10 TypeScript and 2 of 2 SQL mutations were caught.**
**Limits of these tests:** one in-memory database connection cannot prove true parallel locking (the locks are exercised by the SQL tests and the serialized race); the bucket is a fake; real R2 and real Chrome-to-server flows are **UNVERIFIED** until approved.

### 27.9 Release blockers and open items
- **B1 (blocks enabling final submission): no server-side media inspection** (27.5).
- **B2:** migration 00600 is not applied. Before it is applied to DEV, `supabase/live-tests/auth-sessions.live.test.ts` (lines 262, 335, 353–356, 393) still calls the removed `finalize_submission` and must be rewritten (approval-gated suite, so not run or edited here); the live registration test expecting finalization off stays valid.
- **B3:** applying 00600 to DEV, then a controlled live finalization run (with real R2) each need the owner's explicit approval.
- Tamil copy review (D13) and legal review of the consent wording (D5) remain.
- Duration is checked only in the browser; single PUT upload (no multipart or resume); the in-memory rate limiter is per instance; `finalized_at` is the only timestamp of finalization.
- Playback (M5) and admin/judge screens are not started.

**Result: PASS offline. UNVERIFIED against a real database and a real bucket. Public finalization stays DISABLED (blocker B1).**

---

## 28. Sprint 2026-11-06: M4B.2 readiness, M5 judge/admin MVP, M6 scoring and winners (local only)

**Scope kept:** local code and offline tests only. No hosted database contact, no migration applied, no R2 operation, no real test users, no commit, push or deploy. The M4B.2 dry-run was **not run**: the sprint instruction that replaced it did not authorize hosted contact, so `db:dev:dry-run` is still to be done with approval. Flags: `RIO_UPLOADS_ENABLED=no`, `RIO_FINALIZE_ENABLED=no`, `RIO_PLAYBACK_ENABLED=no` (new). Deployment checklist: `DEPLOYMENT.md`.

### 28.1 Stale live tests repaired (M4B.2 Task 1)
`supabase/live-tests/auth-sessions.live.test.ts` depended on the removed `finalize_submission` in seven places (anonymous and judge RPC loops, the cross-parent check, the finalize-and-duplicate test, and the fixtures that set `status = 'finalized'` by direct update). Now:
- fixtures reach `finalized` through the **same service functions the app uses** (`issue_video_upload`, `attach_video_upload`, `finalize_verified_submission`) with synthetic verified values; the secret key is still referenced exactly once (inside the setup client; a test asserts it);
- parents (own and other parents' entries), anonymous users and judges are shown unable to call `check_finalize` or `finalize_verified_submission`, the old function is gone, and direct status writes are refused; the accepted codes are `42501` or `PGRST202` (not callable / not visible), because PostgREST's exposure of service-only functions cannot be confirmed offline;
- three new tests cover the trusted path at database level: stranger = missing entry, changed ETag/size/type refused, finalize once then `already_finalized`, post-finalization lock, duplicate child `23505`;
- `video_uploads` joined the baseline/cleanup table list;
- real-R2 finalization tests are **not** in this file; they belong to the separate approval-gated suite (`e2e-live`).
Nothing was skipped or deleted. Checks: typecheck and lint clean; **discovery** of all 28 tests without executing any hook or touching a hosted project (`vitest list` with dummy local settings); and `supabase/tests/live-fixtures.test.ts` replays the fixtures' exact named-argument RPC sequence on the real migrations (2 tests), so a wrong parameter name is caught offline. **The revised suite has not been run against DEV (UNVERIFIED);** it requires 00600 to be applied first.

### 28.2 Migration 00600 review (Task 2) and migration 00700
| Item | Finding |
|---|---|
| 00500 applied to DEV | recorded in §20; **not re-verified** this session (no hosted contact) |
| 00100–00500 unchanged | hashes: 00100 `fe3e2851f8343d46`, 00200 `224b5d0ce4801714`, 00300 `b36e4314f56dd4f9`, 00400 `8c995be9d66de368`, 00500 `321659c194f2f25d` |
| Pending | **00600** (`539ae80ea433ea86`) and **00700** (`dbedd1f8efabaf09`), both prepared only |
| Old finalizer | dropped in 00600 (test: gone, `42883`, also for the service role) |
| New functions | `check_finalize`, `finalize_verified_submission`, `authorize_playback`: execute for `service_role` only; `assign_judge_to_event`: `authenticated` only, role-checked inside |
| SECURITY DEFINER, search_path | all four: definer, `search_path=''`, owned by the migration role (catalog test) |
| EXECUTE incl. PUBLIC | PUBLIC and anon: none (catalog test reads `proacl`) |
| Ownership, consent, status | `check_finalize`/`finalize_verified_submission`: owner, status `uploaded`, window open, consent present, verified upload of this entry; stranger = missing (tests) |
| Atomic + locking | submission then upload row locked `for update`; `already_finalized` for a repeat; duplicate child `23505`; SQL mutation tests prove the ETag and type comparisons matter |
| Unrelated changes | none: no table, column, policy or table grant is touched (a catalog test lists the 10 tables, all with RLS) |
| Recovery script | reviewed and updated (drops the four functions, clears versions 00600/00700); **not executed** |
**00700** adds only `authorize_playback(judge, submission)` (service role): active judge, assigned, entry finalized with a video, else the identical `not_found`; writes an audit row (judge, entry, ttl 300; no personal data) before returning the opaque video id. And `assign_judge_to_event(judge, event)` (administrators): assigns every finalized entry of the competition not yet assigned, idempotent, returns the count.
**Safe to apply 00600 and 00700 to DEV: YES, offline evidence is complete; the guarded dry-run and the owner's approval are still required.** Order: dry-run, apply 00600 and 00700, run the revised `test:live`, then the live upload suite.

### 28.3 Bounded media inspection (M4B, blocker B1 reduced, not closed)
`lib/submit/inspect.ts`: at final submission, after the ETag/size/type comparison, the server reads a few small byte ranges (never the whole file, no decoding, no transcoding, no new infrastructure): MP4/MOV box walk to the `moov` index (anywhere in the file, at most 12 hops, index up to 4 MiB), a video track, and the header duration; WebM EBML header, `webm` DocType, a video track, and a declared duration. Refused: not a video, wrong container for the declared type, damaged header (`videoInvalid`), declared duration outside 29 to 91 s (`videoDuration`). A bucket failure is "unavailable", never a verdict on the video.
**What it does not prove:** that the frames decode, that a header is honest, or the length of a **browser-recorded WebM, which normally carries no duration** (`durationSeconds: null`, accepted, length unverified). Synthetic containers only; **never tried on real phone videos (UNVERIFIED)**. Decision for the owner: accept this (header-level) level, or fund an `ffprobe` worker outside Vercel.

### 28.4 M5 judge and administrator areas, M6 scoring and winners
- **Sign-in:** the existing email-code login. Roles live in `user_roles` (staff are created by SQL, never self-service; see `DEPLOYMENT.md`). `/account` shows a link to the person's own area. A signed-out visitor is sent to sign-in; a signed-in person without the role sees a plain 404. `proxy.ts` keeps `/admin` and `/judge` sessions fresh. A deactivated judge loses access at once.
- **Judge** (`/judge`, `/judge/entries/[id]`): reads only the `judge_entries` projection (anonymous code, competition, own marks; no child or parent field, no route to `submissions`). Playback: the page holds no video address; pressing "Load video" calls a server action that checks the switch first, then the active-judge session, rate limit 40 per 10 minutes, then `authorize_playback` (database check and audit row) and only then signs a **5-minute** GET link for `videos/<id>`. Own score: draft or final, 0 to 100 with two decimals, comments up to 2000; one row per judge and entry (unique); final is locked (only an administrator can reopen with the existing `unlock_score`). The write runs on the judge's own session, so RLS decides (assigned, finalized entries only).
- **Administrator** (`/admin`, `/admin/events/[slug]`): entries per competition by status (counts only on the overview); judges with assigned, draft and final counts and progress; per competition the entry list, "Assign a judge" (all finalized entries, repeatable), the ranking, winner confirmation and removal, and the publication state (read-only). The child's name is shown only on the competition page, to the administrator, so the display name can be typed by hand.
- **Ranking rules (approved basics only):** only final marks count; the average of the assigned judges' final marks, to 2 decimals in integer hundredths (no float drift); an entry is ranked only when every assigned judge has finalized; equal averages are **flagged as a tie and never resolved**; rank is 1, 1, 3 style. Winner confirmation requires a complete entry; a tied entry needs the administrator's explicit acknowledgement; one winner per rank and per entry (database constraints); nothing is published: the app never writes `results_publish_at` (a static test), and the published view stays empty (tested for anon, parents, judges, with and without a future schedule).
- **Rubric not approved:** D8 is open, so the single 0 to 100 mark is kept (S13); there is no per-criterion form, no weights, no judges-per-entry rule and no tie-break rule. The tie flag and the acknowledgement are the placeholder for the missing rule.
- **Playback switch:** `RIO_PLAYBACK_ENABLED`, exact `yes` only, enforced in the page, the action and the dependency builder; `media-src` in the CSP names the bucket host only when it is on.

### 28.5 Tests (offline)
| Check | Result |
|---|---|
| `npm run lint`, `npx tsc --noEmit` | exit 0, no output |
| `npm test` (Postgres 18) | **606 of 606** (was 513) |
| `npm run test:pg17` (Postgres 17) | **606 of 606** |
| Full browser suite, 2 workers, no retries, against the new build | **131 of 131** (was 101; 21 judge-screen tests, 4 staff-area tests against the real build, others unchanged) |
| `npm run build` | passes; new routes `/admin`, `/admin/events/[slug]`, `/judge`, `/judge/entries/[id]` |
| Mutation checks on this sprint's code | **18 of 18 caught** (playback switch, order of authorize and sign, link lifetime, winner completeness, tie acknowledgement, final lock, drafts or strangers counted, ties broken silently, and six SQL conditions in 00700), plus the earlier 12 |
| Live-suite discovery | 28 tests listed with no hosted contact |
**The journey** (`supabase/tests/mvp-journey.test.ts`, real migrations + the real services + a fake private bucket): parent registers under RLS, uploads (verified), submits with HeadObject re-check and container inspection, admin assigns, judge sees the anonymous entry and receives a 300-second link signed for the right object (audit row, no personal data), judge scores draft then final, unassigned accounts and parents refused, incomplete scoring blocks a winner, a tie is flagged and needs acknowledgement, rank conflicts are refused, nothing is published for anyone. A second test shows a non-video and a too-short file are refused at submission.
**A flaw found in my own earlier tests:** the 360 px browser checks ran without a viewport meta tag, so Chrome used a 980 px layout and the "no horizontal scroll" assertion was trivial; the three specs (upload, submit, judge) now set the viewport and load the built stylesheet, and pass (that includes 44 px control heights).

### 28.6 Launch blockers and what remains unverified
**Blocks production release:** (1) 00600 and 00700 not applied; the revised live suite and the live upload suite not re-run against them; (2) final submission, inspection, playback and judging never exercised against real Supabase Auth/PostgREST, real R2 or real phone videos; a browser GET of a presigned URL under the CSP is untested; (3) WebM durations are unverifiable server-side and inspection is header-level only; (4) rubric and tie rule (D8), judges per entry, consent wording (D5), Tamil copy review (D13), submission dates (D9) undecided; (5) no winner-publication screen: scheduling `results_publish_at` is a database operation until built (M7); (6) staff accounts are created by SQL; (7) the in-memory rate limiter is per instance; (8) no production project, keys, bucket or SMTP; (9) PostgREST returns at most 1000 rows per query, which the pages do not page through (sized for hundreds of entries; `limit(5000)` is requested but the server cap applies).
**Incomplete features:** publication scheduling and public results page; admin screens to unassign a judge, reopen a final score (the `unlock_score` function exists, no button), withdraw an entry, or manage staff; per-criterion scoring; Tamil for the detail labels of the staff screens (headings and main actions are bilingual); judge confidentiality agreement; e-certificates.
**Not claimed:** production readiness. The local build, 606 + 131 tests and the journey test show the code behaves as designed against a faithful Postgres; they do not show it works against the hosted services.

---

## 29. DEV migration dry-run for 00600 and 00700 (2026-11-06): PASS, nothing applied

**Authorization used:** one guarded, non-mutating dry-run against `rio-childrens-day-dev` (ref `rajbfcoxolnjgiqgvflm`). Besides that dry-run, the only hosted contact was **read-only catalog and history queries** through the existing guarded `inspect` command (`--read-only`, fixed queries): migration history and statements, row counts, settings, version, functions, relations, triggers, policies, grants and `video_uploads`. No hosted write, no migration applied, no recovery script, no test user, no R2 operation, no commit or deploy. `RIO_UPLOADS_ENABLED`, `RIO_FINALIZE_ENABLED`, `RIO_PLAYBACK_ENABLED` are all `no`; `RIO_CONFIRM_PUSH` is unset, so a push was impossible in any case.

### 29.1 Target
| Check | Result |
|---|---|
| Dev ref in `.env.live`, live URL, app URL, `RIO_SUPABASE_ALLOWED_REF`, pooler user | all equal the approved ref (booleans only printed) |
| Pooler | Session Pooler, port 5432, user `postgres.<dev ref>` |
| Production (`.env`) | a different project; its ref and publishable key differ from DEV (booleans only; neither printed) |
| Server | Postgres 17.11, UTF8 (matches `config.toml`) |
| Registration | closed: consent version, open and close times, publish time all null |

### 29.2 Pending migrations and hashes
DEV history holds exactly 00100 to 00500. Their stored SQL equals the local files (whitespace and comment-insensitive comparison, all five identical). The dry-run reported `upToDate: false` and would push **only** these two:
| Migration | SHA-256 |
|---|---|
| 20261105000600_final_submission.sql | `539ae80ea433ea865b06dd12a32793667705cb2dbfc41c00aaa7602e2673b653` |
| 20261105000700_judging_support.sql | `dbedd1f8efabaf0960b1b59a65a0418c3c36df297e7fc0d1630b62f062dfabf1` |
Unchanged: 00400 prefix `8c995be9d66de368`, 00500 prefix `321659c194f2f25d`.

### 29.3 Security review
- **Destructive statements:** the two files contain exactly one: `drop function public.finalize_submission(uuid)` (no CASCADE). Their `insert`/`update` statements sit inside function bodies and run only when a function is called, so applying the migrations changes **no data**. No table, column, policy, trigger, index, view or table grant is created, altered or dropped.
- **DEV catalog vs replay:** DEV's functions, relations (RLS flags, policy counts), triggers, policies and grants are **identical** to an in-memory replay of migrations 1 to 5. The same replay with 00600 and 00700 shows the full delta: **removed** `finalize_submission`; **added** `check_finalize`, `finalize_verified_submission`, `authorize_playback` (no EXECUTE for PUBLIC, anon or authenticated) and `assign_judge_to_event` (authenticated only); relations, triggers, policies and grants unchanged. All four new functions are SECURITY DEFINER with `search_path=''`. DEV functions are owned by `postgres`, as the new ones will be. Service-role-only execution of the three server functions is asserted by the catalog test (the inspection query does not list `service_role`).
- **Obsolete finalizer:** it will be removed (delta above; a test proves it is gone, also for the service role). Nothing in the app calls it (static test); the revised live suite asserts it is gone.
- **Playback (10):** `authorize_playback` returns the video id only for an **active** judge who is **assigned** to a **finalized** entry that has a video; otherwise the identical `not_found` (tests: unassigned, other judge, parent, inactive judge, draft, withdrawn, unknown entry), and it writes an audit row without personal data. Six SQL mutations of those conditions were each caught by the tests.
- **Assignment (11):** `assign_judge_to_event` requires the administrator role (parent, judge, anon refused), an **active** judge profile, an existing competition, and assigns only **finalized** entries of that competition; the existing assignment trigger still requires finalized and stamps the assigner; assigning twice adds nothing. A mutation making it open to everyone, and one granting anon, were caught.
- **Existing records (12):** DEV holds 0 submissions, 0 scores, 0 assignments, 0 winners, 6 events, 1 settings row (all null), 1 role row (the banned dummy admin), 128 audit rows, 0 `video_uploads`, none touched by these migrations.
- **Replay evidence:** all 606 unit and database tests pass on Postgres 17; on Postgres 18 one run of the full database directory timed out on the 32-second "replay from empty" test while other files ran in parallel, and the same test passes alone (17 of 17); it passed in the earlier full run.

### 29.4 Warnings (none is a blocker)
1. **The dry-run only lists pending migrations;** it does not parse or execute their SQL. The safety evidence for the SQL is the from-scratch replay on Postgres 17 and 18 and the identity of DEV's catalog with that replay.
2. Applying 00600 breaks any client still calling `finalize_submission`. The app and the revised live tests do not; the **old** live suite would, which is why it was rewritten. Run only the revised one.
3. The revised live suite and the live upload suite have **not** been run against DEV with 00600/00700; both need their own approval after the apply.
4. PostgREST may show service-only functions as `42501` or `PGRST202`; the revised tests accept either.
5. Applying 00700 enables nothing by itself: playback needs `RIO_PLAYBACK_ENABLED=yes`, final submission needs `RIO_FINALIZE_ENABLED=yes`, and no staff role exists in DEV except the banned dummy admin.

**Security blockers: none. Dry-run PASS. Safe to apply both to DEV: YES, once the owner approves the apply** (`RIO_CONFIRM_PUSH` is a human-typed confirmation, then `npm run db:dev:push`).

---

## 30. Migrations 00600 and 00700 applied to DEV (2026-11-06): PASS

**Authorization used:** the owner's explicit approval to apply 00600 and 00700 to **development only** (`rio-childrens-day-dev`, ref `rajbfcoxolnjgiqgvflm`), with the expected hashes. Executed once with `RIO_CONFIRM_PUSH=<dev ref>` set for that single command only (no retry; the variable is unset in the shell and absent from `.env.live`). No recovery script, no test user, no live suite, no R2 operation, no production access, no commit or deploy. Switches `RIO_UPLOADS_ENABLED`, `RIO_FINALIZE_ENABLED`, `RIO_PLAYBACK_ENABLED` are all `no` (`.env.local`; unset in the process).

### 30.1 Precheck (all passed before the push)
DEV identity equal in every setting (dev ref, live URL, app URL, allowed ref, pooler user, port 5432); production is a different project (booleans only); SHA-256 of 00600 `539ae80ea433ea865b06dd12a32793667705cb2dbfc41c00aaa7602e2673b653` and of 00700 `dbedd1f8efabaf0960b1b59a65a0418c3c36df297e7fc0d1630b62f062dfabf1` both **matched** the approved values; history held exactly 00100 to 00500; registration closed (all settings null). Baseline saved (14 read-only inspections).

### 30.2 Execution
`npm run db:dev:push`, exit 0, output: "Applying migration 20261105000600_final_submission.sql... Applying migration 20261105000700_judging_support.sql...". Migration SQL was not modified.

### 30.3 Post-apply verification (read-only)
| Check | Result |
|---|---|
| History | 00100 to 00700 (7 rows); the stored SQL of all seven equals the local files; local files = history, so **nothing is pending** |
| Old `finalize_submission` | **removed** (before: present, executable by authenticated; after: absent) |
| New functions | `check_finalize`, `finalize_verified_submission`, `authorize_playback`: SECURITY DEFINER, `search_path=''`, owner `postgres`, EXECUTE for service role only (none for PUBLIC, anon, authenticated); `assign_judge_to_event`: authenticated only, role checked inside the body |
| Bodies | the md5 of every function body, flags and EXECUTE rights in DEV **equal** an in-memory replay of all 7 migrations (the replay is what the 606 tests exercise); this covers `issue_video_upload`, `attach_video_upload`, `withdraw_submission`, `unlock_score` too |
| RLS, relations, triggers, policies, grants, schema access, view ACLs, default privileges, owner roles | **byte-identical before and after** |
| Registrations, scores, winners | unchanged (0 submissions, 0 scores, 0 assignments, 0 winners, 0 `video_uploads`) |
| Events and settings | six events identical; settings still all null (registration closed) |
| Counts before = after | audit_log 128, event_settings 1, events 6, judge_assignments 0, judge_profiles 0, scores 0, submissions 0, user_roles 1 (the banned dummy admin), winners 0 |
Behavioural claims (only the service role can finalize; playback needs an active assigned judge on a finalized entry; assignment needs the admin role inside the database) rest on the identical function bodies and EXECUTE rights plus the passing offline tests; they were **not** exercised in DEV (no user, no live suite, by instruction).

### 30.4 Offline tests after the apply
Lint and typecheck clean; `npm test` **606 of 606** on Postgres 18 and `npm run test:pg17` **606 of 606**. One addition to the guarded tool: a fixed read-only inspection `judging_function_acls` in `scripts/db-dev.ts` (owner, definer, config, ACL, who can execute, body md5). Two static boundary tests were scoped to `app`, `components` and `lib` because that inspection names `finalize_submission` on purpose.

### 30.5 Findings and remaining blockers
No security finding. Remaining: the revised live suite (`npm run test:live`) and the live upload suite have not been run against DEV with 00600/00700; **the old `finalize_submission` no longer exists in DEV, so the pre-M4B live suite must not be used** (the revised one replaces it); PostgREST's schema-cache refresh and exact error codes for the service-only functions are unobserved; all blockers in §28.6 stand (no real-device, real-R2 or real-Auth verification of finalization, inspection, playback and judging; D5, D8, D9, D13; publication screen; production project).

### 30.6 Plan: ONE revised live end-to-end test (NOT executed, needs its own approval)
**Name and shape.** `e2e-live/journey.liveupload.ts` run by `npm run test:e2e:live:journey` through a wrapper like `scripts/live-upload-run.mjs`: it builds and serves the app from an isolated directory (`.next-journey-test`), saves and restores `tsconfig.json` and `next-env.d.ts`, and is guarded by `RIO_LIVE_CONFIRM=<dev ref>` and `RIO_LIVE_R2_CONFIRM=<dev bucket>`. One serial test, one run, no retry. The three switches are set to `yes` **in that child process only** (the CSP and the server read them at build and start); `.env.local` stays `no`.
**Steps and assertions.**
1. *Preflight (read-only):* dev ref consistent and not production; bucket equals the dev bucket and holds 0 objects; 00700 in history; settings null; 0 submissions and `video_uploads`; the only user is the banned dummy admin.
2. *Provision (service role):* four dummy users (parent, admin, judge1, judge2; random passwords, tagged addresses on a reserved domain, never printed), roles and judge profiles, registration window opened with consent `live-test` (settings snapshot taken first).
3. *Parent, through the real UI:* signs in with a generated one-time code, registers one dummy child, uploads a genuine 31 s WebM (the existing generator) to private R2; before finalizing, a direct API call to `finalize_verified_submission`/`check_finalize` with the parent's token is refused; then "Submit entry" and the confirmation: status `finalized`, summary shown, a second submit answers "already", the entry is no longer editable. The WebM carries no duration, so the run observes the "length unverified" path.
4. *Admin, through the real UI:* signs in, opens the competition page, "Assign a judge" for judge1: one entry added; judge2 has none.
5. *Playback:* judge1 signs in; `/judge` lists one entry code and the HTML holds no child or parent data and no video address; "Load video" returns a link whose lifetime is at most 300 s and host is the bucket host; a ranged GET of that link returns the uploaded bytes; the same object requested without a signature, or with a tampered one, is refused; an `audit_log` row `PLAYBACK_URL` exists. judge2 gets a 404 for the entry and a refusal from the REST call.
6. *Scoring:* judge1 saves a draft (70) then a final score (88.5) after the confirmation; the screen becomes read-only; exactly one score row; judge2 and the parent are refused when writing a score.
7. *Winner:* admin sees the entry ranked 1 (average 88.5, complete), confirms it as winner with a typed display name; the winners row exists; `published_winners` is empty for anon, parent and judge; `results_publish_at` is still null.
8. *Final checks and cleanup (always runs, in a `finally`).*
**Temporary writes.** 4 auth users; 3 role/profile rows; 1 submission, 1 `video_uploads` row, 1 assignment, 1 score, 1 winner; temporary `event_settings` window and consent version; audit rows (permanent by design, ids only); R2: `pending/<id>` and `videos/<id>` for the single upload; one build directory.
**Cleanup.** Delete in dependency order the winner, score, assignment, upload and submission rows collected during the run (ids recorded, never by pattern); delete the two recorded R2 keys (exact keys, no listing-based delete) and confirm the bucket holds 0 objects; delete the dummy users (the existing banned admin keeps the "last administrator" rule satisfied); restore `event_settings` from the snapshot; compare every table count with the baseline (only `audit_log` may grow); restore `tsconfig.json`, `next-env.d.ts` and delete `.next-journey-test`. Any cleanup problem is reported, not hidden.
**Permissions required from the owner.** Approval to run it once; typing `RIO_LIVE_CONFIRM` and `RIO_LIVE_R2_CONFIRM`; temporary process-level `yes` for the uploads, final-submission and playback switches; creation of the four dummy users; opening the registration window briefly; R2 write, read and delete of the two recorded keys; network access to DEV and R2; about three minutes.
**Before it can run (offline work, no approval needed):** write the spec and wrapper, `lint`, `typecheck`, discovery only. **Abort conditions:** any identity mismatch, non-empty bucket, unexpected existing user or data, or a preflight failure aborts before any write.
**Not covered even then:** an MP4/MOV phone video, expiry of the 5-minute link (would need a wait), production, more than one judge scoring one entry, tie handling (offline-tested only).

**Result: PASS (apply and verification). Live behaviour is still UNVERIFIED.**

---

## 31. Live journey test prepared (2026-11-06): READY for one live run, NOT executed

**Scope kept:** offline preparation only. No live journey execution, no hosted write, no R2 operation, no migration, no production access, no commit, push or deploy. Discovery used inert local dummy settings (127.0.0.1, fake keys) so nothing hosted could be reached, and the build directory, `tsconfig.json` and `next-env.d.ts` were checked untouched afterwards. Switches remain `no`.

### 31.1 Files
| File | Purpose |
|---|---|
| `e2e-live/journey.livejourney.ts` | the ONE test (12 steps, fixed-label progress lines, booleans only, no link/key/code/e-mail ever printed) with provisioning in `beforeAll` and always-run cleanup in `afterAll` |
| `e2e-live/playwright.journey.config.ts` | refuses to load without the three confirmations; own web server with the three switches `yes` for that process only, own build dir `.next-journey-test`, `retries: 0`, trace/screenshot/video off |
| `scripts/live-journey-run.mjs` + `npm run test:e2e:live:journey` | wrapper: saves and restores `tsconfig.json` and `next-env.d.ts`, deletes the build dir even on failure; first runs the existing `check-live` guard |
| `scripts/live-journey.ts` (+ `.test.ts`, 16 tests) | pure guards: `assertJourneyTarget`, `preflightProblems`, `playbackLinkProblems`, `tamperedLinks`, `mp4Problems`, `CLEANUP_ORDER` |
| `e2e-live/mp4.ts`, `e2e-live/media.ts` (added `generateMp4`, `probePlayback`) | the MP4 fixture |
| `e2e-live/fixture.livefixture.ts`, `playwright.fixture.config.ts`, `npm run test:fixture` | OFFLINE fixture compatibility check (Chrome only; no server, no environment files) |
| `e2e-live/fixtures/chrome-fragmented-4s.mp4` | a real 55 KB Chrome recording used by the unit test of the converter |
| `lib/submit/inspect.ts` (+ tests) | fragmented-MP4 handling (below) |

### 31.2 Video fixture compatibility (Task 2)
- **Finding 1 (WebM):** Chrome's MediaRecorder WebM reports duration `Infinity`: no duration in the header. The inspector accepts it as "length unknown" (it never required one), so a journey on WebM would not verify a duration.
- **Finding 2 (a real defect, now fixed):** Chrome records MP4 as a **fragmented** file whose movie header says duration **0**. The inspector would have refused such a file as "too short". It now treats a zero header duration with the fragmented-movie marker as "unknown" (or uses a `mehd` total if declared) and still refuses a zero duration without the marker as an empty clip. 3 new tests; two mutations of that logic were caught.
- **Fixture:** a genuine Chrome recording (H.264, 320x240, canvas animation, no person/voice) converted by `remuxFragmentedMp4` to an ordinary MP4: encoded samples copied byte for byte (a test compares the media data), a full sample table and the true duration in the header, like a phone file. Content-Type is the true `video/mp4`; nothing is spoofed.
- **Measured on the installed Chrome 156 (`npm run test:fixture`, PASS, 35 s):** 535,373 bytes, MP4 (H.264), 320x240, Chrome measured **30.88 s**, header says **30.88 s**, 873 samples, not fragmented, **played**; the real inspector returns `ok`, container `mp4`, a real duration (within 0.3 s of Chrome's), using at most 14 small ranged reads, none above 5 MiB; the same bytes declared as `video/webm` or `text/plain` are refused; a damaged header is refused. The journey records **33 s** for margin over the 30 s minimum.
- **Limits:** a canvas recording is not a phone video; an iPhone MOV or a camera MP4 with the index at the end is covered by unit tests only, not by a real file (UNVERIFIED).

### 31.3 Expected coverage (the 18 requested items)
1 real OTP sign-in (parent), 2 registers one dummy child, 3 uploads the MP4 to private R2, 4 the stored object is inspected with the real inspector through the real store (container, true duration) and the server's own inspection runs at finalization, 5 parent finalizes through the UI, 6 the database confirms `finalized` (+ edit/withdraw refused, repeat answered), 7-8 admin signs in and assigns Judge 1 through the UI, 9-10 Judge 1 sees exactly one anonymous entry (no child/parent data in the page or the projection), 11 Judge 1 plays the video: link at most 300 s, for the bucket host and that object, plays in Chrome, serves the uploaded bytes, a tampered signature and an unsigned request are refused, audit row written, 12 Judge 2 sees nothing, gets a 404, cannot score or authorize playback, 13-14 Judge 1 saves a draft then a confirmed final score (duplicate refused, final locked), 15 the administrator sees the ranking (rank 1, 88.5, complete), 16 confirms the winner, 17 `published_winners` empty for anon, parent, both judges and the admin; `results_publish_at` still null, 18 anon, judges and the parent cannot read submissions, winners, scores, uploads or the audit log. Also: before finalizing, the parent's direct calls to the finalization functions and direct status write are refused; non-admins cannot call `assign_judge_to_event`.

### 31.4 Safeguards
- **Start gates:** `RIO_LIVE_CONFIRM` and `RIO_LIVE_JOURNEY_CONFIRM` must both equal the dev ref and `RIO_LIVE_R2_CONFIRM` the dev bucket (dev-looking name, production-looking refused); the existing live-target guard refuses production keys/URL; any of the three switches already on, or `RIO_CONFIRM_PUSH` set, refuses to start. Proven: missing confirmation and a pre-enabled switch are each refused by the real config.
- **Preflight (read-only, before any write):** migrations present (functions answer `not_found`, old finalizer absent), counts of submissions/uploads/assignments/scores/winners/judge profiles all 0, registration closed, results unscheduled, bucket empty, six events; any deviation aborts with nothing written. The video is generated and gated BEFORE any hosted call.
- **Cleanup (always runs):** deletes only rows of the four users and the ids collected during the run, in `CLEANUP_ORDER` (winners, scores, assignments, submissions, judge profiles, roles, users, settings restore); R2 only the exact `pending/<id>` and `videos/<id>` of ids it created (re-checked per key; untracked new objects are reported, never deleted); the audit log is never touched (append-only). Verification compares every table count, the settings, the six events, the auth-user count and the bucket with the baseline (the audit log may only grow). A dummy administrator that cannot be removed is banned and reported.
- **No leaks:** no OTP, key, link or address is printed; assertions compare booleans; consoles are checked for links, keys and addresses; no trace, screenshot or video; the reporter prints only fixed lines.
- **No retries:** `retries: 0`, one test; a failure leaves cleanup to run once and reports.

### 31.5 Offline verification
Lint and typecheck clean; `scripts/live-journey.test.ts` 16 tests and the inspector tests (15) pass; targeted run (lib/submit, scripts, boundary) 173 of 173; fixture compatibility PASS; journey discovery lists the 1 test with no server started and no config file touched. The full unit (606) and browser (131) suites were not repeated: the only application code changed is the inspector (covered by its own tests and a boundary run).

### 31.6 What this still cannot establish, and blockers
The 12 UI steps and their selectors are written against components pinned by browser tests but have **never run end to end**; the first live run may fail on a selector, a timing or a PostgREST code (the permission assertions accept `42501` or `PGRST202`). The 5-minute expiry, an MP4/MOV from a phone, a second judge scoring the same entry and a tie are not covered. All §28.6 blockers stand. Needs the owner: approval of ONE run with the three typed confirmations, temporary process-level switches, four dummy users, a brief registration window, and R2 write/read/delete of the single upload's two keys.

**Result: READY for one live run (preparation PASS). Live behaviour UNVERIFIED.**

---

## 32. Live end-to-end journey on DEV (2026-11-06): PASS, one execution, cleanup verified

**Authorization used:** the owner's explicit approval of ONE execution of the prepared journey test (§31) against `rio-childrens-day-dev` (ref `rajbfcoxolnjgiqgvflm`) and the R2 bucket `rio-childrens-day-dev`. Executed once with `npm run test:e2e:live:journey` through the guarded wrapper, the three typed confirmations set inline for that one command only (unset in the shell and absent from every env file afterwards). No retry, no application code, migration or test changed during the run. Wall time 16:10:15 to 16:13:12 including the isolated build. No production access, no commit, push or deploy.

### 32.1 Preflight (all passed before the run)
DEV identity equal in every setting, production a different project, history 00100 to 00700, the three switches `no` (shell unset, `.env.local` `no`), registration closed (all settings null), baseline counts (audit_log 128, events 6, user_roles 1 = the banned dummy admin, everything else 0), `video_uploads` 0, **bucket 0 objects**, Supabase Auth health HTTP 200, machine CPU 16 %, 4.5 GB free, port 3100 free, the MP4 fixture re-verified by `npm run test:fixture` (PASS) and the guard/inspector unit tests (31 of 31). The test itself repeated the preflight in code and aborts before any write on any deviation. "Cleanup after a partial failure" was checked by reading the code (every cleanup step is independent and bounded, runs after a failed provisioning, and works from whatever ids exist); it was **not** exercised by an induced failure.

### 32.2 Result: PASS (1 test, exit 0)
| # | Step | Result |
|---|---|---|
| 1 | Parent signs in with a real one-time code | PASS |
| 2 | Registers one dummy child (draft) | PASS |
| 3 | Uploads the genuine MP4 (550,395 bytes, 33 s) to private R2; verified; stored as `video/mp4` at `videos/<id>`; `pending/<id>` removed; the real inspector read the stored object through ranged reads: MP4 container and a **verified duration of about 33 s** | PASS |
| 4 | Parent's direct calls to `finalize_verified_submission` / `check_finalize` and a direct status write refused | PASS |
| 5 | Parent finalizes through the app; the database confirms `finalized` with a timestamp; repeat answered "already"; edit and withdraw refused | PASS |
| 6 | Administrator signs in and assigns Judge 1; exactly one assignment; non-admins refused by the database | PASS |
| 7 | Judge 1 sees exactly one anonymous entry; no child or parent detail in the page, the projection or `submissions` | PASS |
| 8 | Playback: no video address in the page before pressing the button; link for the bucket host and this object, **lifetime at most 300 s**; plays in Chrome; serves the uploaded bytes; a tampered signature and an unsigned request are refused (4xx); audit row written, with no personal data | PASS |
| 9 | Judge 2: empty list, 404 for the entry, no rows from entries, submissions or scores, cannot score, cannot authorize playback | PASS |
| 10 | Judge 1 saves a draft (70), then a confirmed final score (88.5); locked; duplicate refused (`23505`); scores invisible to the parent and Judge 2 | PASS |
| 11 | Administrator sees the ranking (rank 1, average 88.5, 1 of 1 judges, ready) and confirms the winner with a typed name | PASS |
| 12 | `published_winners` empty for anon, parent, both judges and the administrator; `results_publish_at` still null; anon, judges and the parent read none of submissions, winners, scores, uploads or the audit log; consoles free of links, keys and addresses | PASS |
**Server-side inspection:** the app's own finalization (which inspects before the transition) succeeded on this file; the test additionally ran the same inspector on the stored object and observed the verified duration. A live **refusal** of a bad file was not run (spoofing a type or uploading a fake is out of bounds).

### 32.3 Cleanup, verified independently after the run (read-only)
| Check | Result |
|---|---|
| Table counts vs baseline | all equal except `audit_log` 128 to **154** (+26, append-only, expected) |
| Remaining test data | none: 0 submissions, scores, winners, assignments, judge profiles, `video_uploads`; roles = the one existing admin |
| Auth users | 1 (the existing banned dummy admin); the four test users are gone |
| Settings | restored to the baseline (all null: registration closed again); results unscheduled |
| Six events | identical |
| R2 bucket | **0 objects** (baseline 0): only the exact keys of the test's own upload were deleted |
| Catalog | functions, relations, triggers, policies and grants identical to the post-apply state; history 00100 to 00700 |
| Audit rows added | 26, by table and action only: settings updates (open, restore), role/profile/assignment/score/winner inserts and deletes, the two submission status changes, one upload insert and verify, **one `PLAYBACK_URL`**; none contains an address, a link marker or an R2 host |
| Local files | `.next-journey-test` removed; `tsconfig.json` and `next-env.d.ts` content original (the wrapper rewrote them from its saved copy, so only their timestamps changed); the leftover Playwright `test-results/.last-run.json` removed; port 3100 free |
| Switches and confirmations | `RIO_UPLOADS_ENABLED`, `RIO_FINALIZE_ENABLED`, `RIO_PLAYBACK_ENABLED` still `no`; `RIO_LIVE_CONFIRM`, `RIO_LIVE_JOURNEY_CONFIRM`, `RIO_LIVE_R2_CONFIRM`, `RIO_CONFIRM_PUSH` unset and in no file |

### 32.4 What this proves, and what it does not
- **Proven live on DEV:** the complete designed path works through the real app, real Auth, real RLS and a real private R2 bucket: server-side finalization with HeadObject re-check and header inspection, the database authorization for assignment, the 5-minute private playback link (and its refusal when altered), judge isolation, scoring rules, ranking, winner confirmation by a human, and that nothing is published. Cleanup left DEV exactly as found.
- **Not proven:** a phone-recorded MP4 or MOV (the fixture is a Chrome canvas recording converted to an ordinary MP4); expiry of the link after 5 minutes; a rejected video live; more than one judge on an entry; a tie; load; production resources; the PostgREST error codes for service-only functions were accepted as `42501` or `PGRST202` (which one occurred was not recorded); the Tamil text; the legal consent wording.
- **Cosmetic:** the journey guard's message for a missing bucket confirmation says "live upload test" (reused text).

### 32.5 Remaining blockers for production
Unchanged from §28.6 and §30.5 except that the "never exercised live" items for finalization, inspection, playback, assignment, scoring, ranking and winners are now exercised once on DEV. Still open: decisions D5 (consent wording), D8 (rubric, judges per entry, tie rule), D9 (dates), D13 (Tamil review); no winner-publication screen; staff accounts by SQL; header-level inspection only (browser-recorded WebM carries no duration); phone-video and expiry tests; per-instance rate limiter; no production project, keys, bucket, SMTP or domain; no deployment; no load or accessibility audit of the new screens. The three switches stay `no`.

**Result: PASS. Production readiness: NOT production-ready; the end-to-end design is verified on DEV once.**

---

## 33. M7 launch readiness (2026-11-06): code complete for the public results page; NOT READY for production

**Scope kept:** local code, tests and documents only. No production modification or resource, no hosted migration, no R2 operation, no deployment, no commit or push, registration not reopened (DEV settings are still all null), switches `no`. The completed live suites were not repeated. One anonymous read of public DEV data (the built server rendering `/results` once) was the only hosted contact. The release checklist is `DEPLOYMENT.md` (rewritten: functionality, environment variables, production resources, approvals, risks and blockers, deployment steps, post-deployment checks, go/no-go).

### 33.1 Changes
- **Public winners page `/results`** (`app/results/page.tsx`, `lib/results/public.ts`, `lib/results/messages.ts`, `components/results/winners-list.tsx`, footer link, `next.config.ts` header). It reads only the `published_winners` view and the publication time with the anonymous key and no session, never writes, validates every row (unknown competitions and malformed rows are dropped), and shows nothing but the announcement line (14 November 2026, already on the landing page) until the database releases rows. It never shows the scheduled time, invents no name or date, and cannot publish. Rendered on every request (`force-dynamic`) and served with `Cache-Control: no-store, max-age=0`; the build lists `/results` as dynamic and writes no prerendered file. A built server on DEV answered with the no-store header, the "to be announced" text and no bucket host in the policy.
- **Defect found by the 360 px test and fixed:** a long unbroken winner name stretched its card to 851 px; the cards now wrap anywhere (`min-w-0`, `overflow-wrap: anywhere`).
- **Privacy gap closed in the display:** the administrator competition page now shows whether the parent gave the optional permission to share the child's first name, and the confirm form warns when it was not given. It does not block (policy is the client's decision).

### 33.2 Tests
| Check | Result |
|---|---|
| Lint, typecheck | clean |
| Results unit tests (9), results database tests (7, real migrations), static guards | pass; targeted run of 11 files: **148 of 148** |
| Database results tests | view has exactly 4 columns; empty for anon, parents, judges and admin when unscheduled or scheduled in the future; after the time passes (the date CHECK dropped inside the rolled-back test transaction, since today is before the 14 November floor) everyone sees the confirmed winners and only their public fields; unconfirmed entries never appear; removing a winner removes it at once; `winners` table closed to the public/parents/judges; scheduling before 14 Nov refused; non-admins cannot schedule |
| Browser (built stylesheet): results states, rank order, AA contrast, 360 px | 6 of 6; with the smoke and staff-area specs re-run after the footer change: **30 of 30** |
| Mutations | 6 of 6 caught (no-store header removed, page made cacheable, time check inverted, unknown competition shown, `select *`, SQL view ignoring the publication time); migrations restored byte for byte |
| Production build | passes; `/results` dynamic |

### 33.3 Critical launch checks (what was verified, and what is still open)
| Check | Result |
|---|---|
| Parent and child data private | RLS tests + DEV journey; the public results code is statically barred from touching submissions, owner or child fields |
| Judge authorization | enforced in the database and proven on DEV (journey) |
| R2 not public | no public URL or `r2.dev` in the code (static test); DEV: unsigned and tampered requests refused; **production bucket does not exist yet** |
| Results unpublished | DEV settings null; `/results` shows only the announcement line |
| Registration closes outside the window | database guard and tests; DEV closed; **not re-run on production** |
| Representative mobile formats | **NOT verified**: only Chrome-made MP4 and WebM exist as fixtures; iPhone MOV/HEVC, Android camera files, a 100 MB file on a mobile network are untested (blocker B4). Playback of HEVC on a judge's desktop browser may fail |
| Consent wording | only `v0-provisional` exists and says it is provisional; **nothing prevents opening registration with it** (documented as a go/no-go item, not changed: guarding it would alter the verified DEV journey) |
| Judging rules | not invented: single 0 to 100 mark, ties flagged, administrator decides |
| Rate limiting | in memory per instance: **explicit blocker B1** |
| Inspection | header level only; not claimed to prove media integrity (B5) |

### 33.4 Result
**NOT READY for deployment.** Blockers and client decisions are in `DEPLOYMENT.md` sections 4, 5 and 8 (17-item go/no-go: 4 met, 13 not met). Next actions are listed in the M7 report.

---

## 34. Staff email-and-password sign-in (2026-11-06): built and tested offline, not run against DEV

**Scope kept:** local code only. No hosted user was created, no hosted write or sign-in attempt, no migration (none needed: the existing `user_roles` and `judge_profiles` tables and their RLS are reused), registration dates untouched, switches not enabled, no commit or push. Parent email-code sign-in is unchanged in behaviour.

### 34.1 Flow
`/staff/login` (English first, short Tamil second; email, password with a show/hide button, "Sign in") posts to the server action `staffSignIn`: (1) validate the email shape and a non-empty password (nothing is sent to Supabase otherwise); (2) rate limit, in memory (15 per address and 6 per email per 10 minutes, a first layer only: blocker B1 of `DEPLOYMENT.md` stands); (3) `supabase.auth.signInWithPassword`; (4) **the role is then read with the person's own session** (`user_roles`, plus `judge_profiles.active` for judges); (5) administrator goes to `/admin`, an active judge to `/judge`; a parent, an account with no role, or an inactive judge is **signed out again** and refused; (6) every failure is generic: a wrong password, an unknown email, an unconfirmed or banned account and an account with no password at all (every parent) give the same message. The password goes only to Supabase Auth; it is never logged, stored, returned, put in a URL, or put back into the form (only the email is). `/admin` and `/judge` (and their sub-pages) now send a signed-out visitor to `/staff/login`; a signed-in parent or the wrong role gets a plain 404, as before. Sign-out is a button in a bar above both areas, shown only to a verified member of that role; it ends this browser's session and returns to `/staff/login`. There is no registration, invitation, sign-up or password-reset path in the app (a static test forbids them).

### 34.2 Provisioning (DEV, no password stored anywhere)
`npm run staff:provision -- --role admin|judge --email <email> [--name "<display name>"] [--reset-password]`, with `RIO_LIVE_CONFIRM` and `RIO_CONFIRM_PROVISION` both typed as the dev ref for that one command. It refuses the production project and a local stack; the password is typed twice at a hidden prompt (or taken from `RIO_STAFF_PASSWORD` set for one command) and is passed only to `auth.admin.createUser` / `updateUserById`; it prints nothing secret, rejects a password on the command line, enforces 12 to 128 characters and a few weak-password rules, never changes an existing different role, and is safe to repeat. **It has not been run** (that would create a hosted user). Production: dashboard "Add user" (password typed there), then SQL that contains no password (`DEPLOYMENT.md` section 6, step 5).

### 34.3 Item 14: the `/signin` email error
The local check was tested with 23 addresses. It accepts every ordinary shape (dots, plus tags, upper case, subdomains, hyphens, apostrophes, surrounding spaces, newline, non-breaking space). **Two real causes found and fixed:** (1) when Supabase itself refuses a well-formed address (for example a domain it does not accept; its error `email_address_invalid`), the app said "Enter a valid email address", which is wrong for a syntactically valid address; it now says "This email address was not accepted. Check it for typing mistakes, or use a different address." (2) A zero-width space or similar invisible character, common when an address is copied from a web page or chat, made a visible-valid address fail; those characters are now removed before the unchanged check (nothing invalid becomes valid; tested). Addresses that are valid by the RFC but very unusual (special symbols, unicode domains, single-label hosts) are still refused, as before. Without the exact address that failed, the first cause is the most likely one (for example an `example.com` or `.test` address); please re-test with the real address.

### 34.4 Tests
| Check | Result |
|---|---|
| Lint, typecheck, production build | clean; build lists `/staff/login` (dynamic) and all earlier routes |
| Staff login logic (15), actions with a fake Supabase (11), role lookup over the REAL migrations and RLS (9), provisioning script (18), email schema and error mapping (+7), static guards (+7) | pass; the targeted run of 23 files: **383 of 383** |
| Role cases | admin correct: `/admin`; active judge: `/judge`; wrong password: generic error, no redirect; parent: refused; account with no role: refused and signed out; inactive judge: refused and signed out; claimed role in token metadata: ignored; a judge or parent cannot read another person's role; anonymous database session: refused and treated as no access |
| Browser, real form with a fake action (14) and real built pages (6) | pass; includes show/hide, Enter submits once, the five error states in English and Tamil (email kept, password cleared, never in the page or the address), double click sends one request, keyboard order, 360 px with 44 px controls and AA contrast, `/staff/login` not indexed and offering no registration or reset, all four staff URLs redirecting a signed-out visitor to `/staff/login`, and `/signin` unchanged |
| Parent OTP unaffected | `auth`, `otp-form`, `smoke` browser specs and `app/signin` unit tests re-run: 48 of 48 browser tests with the staff-area spec, all passing |
| Mutations | 9 of 10 caught (role never checked, session kept for unauthorized accounts, everyone sent to `/admin`, inactive judges accepted, account-revealing error, wrong redirect target, password put back into the form, email limit removed, public sign-up added). The one "miss" (role read from token metadata) was an artificial change that the lookup never sees; the real property is tested separately with metadata claims |

### 34.5 Remaining blockers and notes
1. **Not run live:** no staff account exists on DEV, so `signInWithPassword` against the real project is unverified; the project's email provider must allow password sign-in (the default), and Supabase's password rules should be set. Needs approval to create the first DEV accounts.
2. The rate limiter is in memory per instance (B1); with passwords this matters more: add the firewall rule or a shared store before public use. Supabase's own limits remain.
3. Staff accounts can still sign in with an e-mailed code at `/signin` (same account, same role check).
4. The `RIO_PLAYBACK_ENABLED=no` line is no longer present in `.env.local` (it was on 2026-11-06 earlier); the switch is off because only the exact value `yes` turns it on, but the line was not restored because the file was changed outside this task.
5. The Tamil text on the new page is provisional (D13). All earlier blockers in `DEPLOYMENT.md` stand.

## 35. Landing refinement, registration clarity and confirmation e-mail (2026-11-06): built and tested offline

Local work only: no hosted write, no e-mail sent, no migration applied, nothing committed, deployed or opened. Registration is still closed and the switches `RIO_UPLOADS_ENABLED`, `RIO_FINALIZE_ENABLED`, `RIO_PLAYBACK_ENABLED`, `RIO_EMAIL_ENABLED` are all off.

### 35.1 Public pages
- Landing (`/`): short hero with Tamil and English headings and two calls to action (both go to the competition section), six competition cards (name, age group, one line, View details / Register), how to participate, compact rules, small footer. Shows whether registration is open from one public fact (cached 60 s; unreadable means closed).
- Look follows the hospital website's visual language, not a copy: blush and light-blue sections, indigo headings, pink primary buttons with navy text, rounded cards. Measured: navy on pink 5.3:1 (white on pink only 2.6:1, so not used), 20 landing pairs checked in the browser.
- **Deviation from CLAUDE.md, recorded there:** the yellow accent and colour table are superseded by the owner's direction. Everything else in that section still applies.

### 35.2 Registration
- The chosen competition is carried through; required fields say "Required" in words; guardian consent is required; media sharing is optional and says taking part does not depend on it.
- A saved draft or uploaded video is labelled in words as "not submitted yet"; only "Submitted: final" is final. Progress steps (1 save, 2 upload, 3 submit) say done, next or later. The confirmation shows the reference, the competition, the date and the announcement date, and mentions an e-mail only when one will really be sent.

### 35.3 Confirmation e-mail
- After a successful final submission (never a repeat), the server records the intention in `email_outbox` and tries to send; a failure never undoes the submission. Unique per submission and kind, atomic claim, backoff, abandon after 8 tries, provider idempotency key, address read from the verified parent e-mail at send time. Content: competition, reference, announcement date; no video, no link, no private storage address.
- Sending is off unless `RIO_EMAIL_ENABLED` is exactly `yes` and provider settings exist. `GET /api/email-sweep` (bearer secret, 404 otherwise) retries failures.
- Migration `20261105000800_email_outbox.sql` is **prepared, not applied** (hash prefix `1d52fdcc7890f69a`).

### 35.4 Open items
1. The reference image was not supplied; the hospital website was the guide. The owner must approve the new look (D1, D13).
2. The logo file used (`rio logo v2.png`) differs from the blue logo on the poster; the owner must confirm which is approved.
3. E-mail: provider, verified domain, migration 00800, scheduler and a real test message are all still to do. Nothing was sent for real.
4. axe was not run (not installed); roles, contrast, focus and target sizes were checked in the browser instead.
5. The staff sign-in screens have still not been tried live. The rate limiter is still in memory (B1). Tamil text is provisional.


## 36. Final UI/UX redesign (2026-11-06): built and tested offline

Local work only: no hosted write, no migration, no commit, no deployment. Registration is closed and all four switches are off. Backend, RLS, Parent OTP, staff password sign-in, R2 upload, finalization and scoring were not touched.

### 36.1 What changed
- **Design system** (`app/globals.css`, `components/ui/`): navy `#173B78`, CTA rose `#D4206B`, decorative pink `#EE3F86`, blush `#FFF1F6`, light blue `#EAF4FC`. The mock-up pink gives only 3.7:1 with white text, so buttons and pink text use the deeper rose (4.98:1). Shared `.btn`, `.card`, `.field`, `.chip`, `.wash` styles; monoline icon set; section heading, steps and info strip components; header with mobile menu; navy footer.
- **Pages:** landing (`/`), new `/competitions` (age filter 3 to 12, Eligible and Not eligible per card, four-step indicator), competition details, registration (summary panel, three form sections, four-step progress, Continue to upload), success summary, administrator dashboard (real counts, progress bars), judge list and entry review (anonymous, secure playback, score). Sign-in and staff login take the same look.
- **Old poster removed** from every public page and from `public/` (moved to `design-references/old-poster/`, git-ignored). The poster URL now returns 404.
- **Dates:** none hardcoded. `lib/events.ts` `announcement` is `null` until the client approves a date; every page, the results page and the confirmation e-mail then say the date will be confirmed later. The "age on 14 November" label became "Child's age". Database CHECKs were not changed.
- **E-mail wording:** the success page never says an e-mail was sent; it says one WILL be sent only when sending is on. The participation certificate is shown as planned, not available.

### 36.2 Tests
New or rewritten: landing, competitions (age filter checked against `fitsAge` for every age), register-page (the REAL page in five states), registration-ui, staff-pages (the REAL admin and judge pages with a fake database; numbers counted from rows). A shared audit measures overflow, tap targets and the contrast of every text at 360, 390, 768 and 1440 px. It found and fixed one real defect (green on pale green, 4.39).

### 36.3 Missing approved assets
Hero photograph of two children, per-competition illustrations, success-page celebration art, building and giraffe background art, the lotus logo of mock-ups 01 and 02. None was supplied, so none was drawn (CLAUDE.md bans redrawn artwork); monoline icons and CSS shapes stand in.


## 37. Admin, judge and registration management (2026-11-07): built and tested offline

Local work only: no migration (none is needed), no hosted write, no staff account or invitation created, no e-mail sent, no R2 write, registration not opened, nothing committed or deployed. All switches are off, including the new `RIO_STAFF_INVITES_ENABLED`.

### 37.1 What was added
- **Staff login** is one small icon button (user with a cog, `aria-label="Staff login"`) at the right edge of the public header on every screen size. It opens a menu (arrow keys, Home/End, Escape, outside click) with Admin Login and Judge Login, both to the existing `/staff/login`. The footer and the phone Menu no longer list the logins, so there is one entry point (`components/staff-menu.tsx`). `?role=admin|judge` only changes the heading and is never read for access; there is still one sign-in.
- **Admin sidebar** (Dashboard, Registrations, Judges, Assign Judges, Scoring, Results, Event Settings), shown only to a verified administrator. The last four open existing sections (competition page anchors, the dashboard's settings), not new screens.
- **`/admin/registrations` and `/admin/registrations/[id]`:** counts and a searchable, filterable, paged table, and an administrator-only details page, all read with the administrator's own session. A draft is never shown or counted as a submission. The private video reference is reduced to a yes/no.
- **`/admin/judges`:** name, e-mail, status (invited, active, inactive), assigned entries, scoring progress; Activate and Deactivate (deactivation needs a confirmation that the server also enforces); an invitation form that is disabled and says why until invitations are switched on.
- **Judge invitation:** Supabase Auth sends the e-mail (`inviteUserByEmail`); the judge sets a password at `/staff/set-password` from a one-time link (the token is used only when the form is sent). The role and profile are recorded with the administrator's own session. An e-mail that already has an account is refused. Partial failures are undone where that is safe and otherwise reported exactly.
- **Event settings** on the dashboard: read-only open or closed, opening and closing time in IST, timezone Asia/Kolkata. Nothing there can be edited.
- **`/dev/registration-preview`:** the real registration form with empty, error and draft states and a stand-in action that runs the real validation and does nothing. It is a 404 whenever `NODE_ENV` is production.

### 37.2 Security basis
Administrator-only reads of personal data rely on existing row level security (an administrator reads all submissions; a judge and an anonymous caller read none) and on `requireStaff("admin")` first on every page. Every judge action calls `staffSession("admin")` before anything else. The secret key is built in one file (`lib/staff/invites.ts`), only after those checks. Judges cannot create judges: only an administrator can insert roles (policy), and the invitation path can only grant the judge role.

### 37.3 Tests
Real-database tests of the exact reads and writes as administrator, judge, parent and anonymous caller (`supabase/tests/admin-management.test.ts`); unit tests of the invitation flow (duplicate, rate limit, partial failure, no deletion of old or signed-in accounts), the password setup, the actions (a non-admin gets "notAllowed" with nothing built or called), filters; static guards; browser tests on the real pages at 360, 390, 768 and 1440 px (contrast, overflow, tap targets) and on the production build.

### 37.4 Open items
1. No judge invitation has been sent for real: SMTP of Supabase Auth, the invitation template, Site URL and a received test invitation are all still to do, then `RIO_STAFF_INVITES_ENABLED=yes`.
2. Viewing personal data is not audit-logged: the audit log is written only by database triggers and a read has none. Logging reads needs a reviewed migration (not added).
3. "Video verified" is derived from the entry status (an entry only becomes `uploaded` after the server verified the stored object); the `video_uploads` table is service-role only and is not read by these screens.
4. The registration list reads up to 5,000 rows and filters them in the server; a very large event needs database-side paging.
5. An administrator's own judge-or-admin role cannot be changed from the screen; an administrator role can only be granted outside the app.

## 38. Manual judge account management (2026-11-07): built and tested offline; no account created, nothing sent

Replaces the need to e-mail invitations. The administrator creates a judge directly at `/admin/judges`. **No migration is needed or added.** No hosted Supabase write, e-mail, R2 write or date change was made.

### 38.1 What it does
- **Add judge** (name, e-mail, a box "I have confirmed that this e-mail address belongs to the judge", button). The server action verifies the administrator session first, then the switch, then the secret key. It generates the password on the server (Web Crypto, 20 letters and digits without look-alikes in five hyphenated groups, 24 characters, about 115 bits), calls Supabase Auth `admin.createUser` (`email_confirm: true` only because the administrator vouched for the address; `app_metadata.must_change_password: true`), then with the **administrator's own session** inserts the `judge` role, inserts the profile **inactive**, and switches it on as the **last** step. Any failure undoes the earlier steps newest first; if an undo also fails the answer is "partial" (no role or an inactive profile, password never shown). A duplicate address is refused by Supabase and nothing existing is touched or converted.
- The password is returned once to that administrator, shown as text (not in a form field), with Copy password, Copy sign-in details and "I have saved it" buttons; it disappears on hiding, after 5 minutes, or on leaving. It is never written to a table, log, URL, storage or e-mail.
- **Reset password** per judge (confirmation first): the server writes the audit row, then sets a new generated password and the mark. The old password is never read. Existing sessions are not ended (see 38.4).
- **First login**: `/staff/login` is unchanged. `lib/staff/auth.ts` gives no staff session (every action returns "not allowed") and sends every staff page to `/staff/set-password` while `app_metadata.must_change_password === true`. Only the secret key can write `app_metadata`; the judge cannot clear it. The mark is lifted by `app/staff/set-password/actions.ts` only after Supabase accepted the judge's own new password (the same password is refused by Supabase).
- Inactive judges are refused at sign-in and by every check (unchanged). A judge sees only assigned entries by code, never parent or child data; R2 playback, scoring and finalization are unchanged.
- The judge list shows name, e-mail, status (Not signed in yet / Active / Inactive), "Password change pending", assigned count, scoring progress, Activate/Deactivate and Reset password. The invitation form is removed from the page; the invitation code and its switch `RIO_STAFF_INVITES_ENABLED` are left in place, off and unused.

### 38.2 Switch
`RIO_STAFF_PROVISIONING_ENABLED`, server-only, default OFF, only the exact value `yes` allows creating or resetting. It never reads or reuses `RIO_STAFF_INVITES_ENABLED`. Needs `SUPABASE_SECRET_KEY`. Changing it needs a redeploy.

### 38.3 Tests
Unit (`lib/staff/provisioning.test.ts`, `lib/staff/auth.test.ts`, `app/admin/judges/actions.test.ts`, `app/staff/set-password/actions.test.ts`): admin can provision when enabled; non-admin cannot; disabled blocks; duplicate; rollback at each step and a failed undo; password rules and uniqueness; first-login gate; inactive judge; the mark is lifted only after the password was accepted. Real-database (`supabase/tests/admin-management.test.ts`): the steps as administrator, judge, parent, anonymous; inactive-first; audit rows with the administrator as actor and no personal data; a new judge sees no submissions. Static guards and browser tests at 360, 390, 768 and 1440 px (contrast, overflow, tap targets, with the password shown).

### 38.4 Open items and limits (to decide)
1. **Audit of a password reset** has no table change to trigger on, so it is recorded as an `UPDATE` of the judge's profile with unchanged state, written by the administrator before the password is changed. It is not labelled "password reset". A labelled event needs a small migration (a service-restricted function that inserts an `audit_log` row). **Not implemented; needs approval.**
2. **The first-login rule is enforced by the application, not by the database.** A judge holding the initial password could call the Supabase Data API directly; row level security still limits them to their assigned entries by code, but the rule is not in the database. Enforcing it in RLS needs a migration.
3. A reset does not end the judge's existing sessions (the Auth admin API ends sessions only with the user's own token). The pending mark does block every action of an existing session until the password is changed.
4. The administrator is trusted to have verified that the e-mail belongs to the judge; the box records the statement on screen only (it is not stored).
5. Judge accounts are still not created anywhere: switch off, no hosted write made.
6. Removing the unused invitation code (`inviteJudge`, `lib/staff/invites.ts` flow, template, switch) is a separate clean-up.

## 39. Judge provisioning security review (2026-11-07): one migration prepared and tested locally; NOT applied to DEV or production

Closes the three gaps listed in section 38.4. Migration `supabase/migrations/20261105000900_judge_password_gate.sql` (SHA-256 prefix `891609dc54f9b03b`), rollback `supabase/rollback/20261105000900_down.sql` (by hand only), tests `supabase/tests/judge-password-gate.test.ts`. Applied only to in-memory local databases (Postgres 17 and 18).

### 39.1 Direct Data API review (what a signed-in judge can do)
Reads: own `user_roles` row, own `judge_profiles` row, own `judge_assignments` rows (opaque ids), own `scores` (only while `is_judge()`), the `judge_entries` view (only while `is_judge()`), public data (events, settings, published winners). Writes: `scores` insert and update on assigned finalized entries (through `judge_can_score`, which calls `is_judge()`), nothing else (no delete right, no other table). No route to `submissions`, `audit_log`, `winners`, `video_uploads` or `email_outbox`. `authorize_playback` is service-role only.

### 39.2 Findings fixed by the migration
1. **A judge with the initial password could use the Data API directly** (read assigned entries, write scores) because only the application enforced the first-login rule. `private.is_judge()` now also requires "no password change pending", read from `auth.users.raw_app_meta_data` on every call through a private SECURITY DEFINER helper that no client role can execute. The state is the account row, not the token: a token issued before a reset is refused the moment the mark is set. Only the secret key can write `app_metadata`; `user_metadata` (editable by the user) is ignored; a missing account row counts as pending.
2. **A judge could list the ids of their assigned entries even when deactivated** (`assignments_read`). Now requires `is_judge()` too.
3. `authorize_playback` (service role) gets the same check.
4. **Password-reset audit**: `public.record_judge_password_reset(actor, judge, outcome)`, service-role only, writes `JUDGE_PASSWORD_RESET_STARTED`, `JUDGE_PASSWORD_RESET` or `JUDGE_PASSWORD_RESET_FAILED` with the administrator, the judge and the time, and `{"outcome": ...}` only. It checks the actor is an administrator and the target a judge. Because only the server can call it, an administrator cannot forge or skip the rows. The reset no longer rewrites the judge profile, so the earlier misleading `UPDATE` row is gone. The app writes STARTED first (if that fails nothing changes), then sets the password, then SUCCESS or FAILED.

### 39.3 Session safety (documented Supabase mechanisms only)
Supabase documents no admin call that ends all sessions of a user by user id; `auth.admin.signOut(jwt)` needs that user's own valid token, which an administrator does not have. Access tokens stay valid until they expire (default 1 hour). Strategy: (a) the reset sets the mark, and the database gate and the application gate refuse the judge's existing sessions and tokens at once, whatever their remaining lifetime; (b) the judge's own password change goes through Auth's documented password update, after which the mark is lifted; (c) recommended Auth settings: JWT expiry 1 hour or less (not below 5 minutes); on a Pro plan, "Single session per user", "Time-box user sessions" and "Inactivity timeout". Undocumented operations (deleting `auth.sessions` rows, ban and unban tricks) are not used.

### 39.4 Open items
1. Apply 00900 to DEV (read of `auth.users` by the migration owner must be confirmed there: it is the standard Supabase pattern, but it was tested only against the local stand-in), then rerun the DEV database checks. Needs approval.
2. A judge account created by hand in the dashboard (DEPLOYMENT section 6, step 5) is not marked, so it is not gated; the manual procedure should set the mark or the judge should be created from the screen.
3. Rolling back 00900 returns to application-only enforcement.

## 40. Preview readiness check for manual judge provisioning (2026-11-07)

Migrations 00800 and 00900 are applied to the DEV project (guarded push; catalog verified identical to a local 00100 to 00900 build). They are in the repository and were not applied again.

### 40.1 Rio Admin "Add judge" versus creating a user in the dashboard
| | Rio Admin, Add judge | Supabase dashboard, Add user |
|---|---|---|
| Password | generated on the server, 24 characters, shown once to the administrator | typed by the person creating it |
| First-login mark (`app_metadata.must_change_password = true`) | set in the creation call, **read back from the saved account; if it is not exactly true the account is deleted again and nothing is left** | **not set** |
| Role and profile | role, then profile inactive, then activation last, with the administrator's own session and audit triggers | by hand in SQL |
| Judge area before the password change | closed by the application (`lib/staff/auth.ts`) and by the database (`private.is_judge()`) | open: no mark, so no gate |
| Reset | mark set and confirmed FIRST, then the password changed in a second call, so no known password ever exists without the mark | dashboard password change: no mark |

### 40.2 Defects fixed in this check
1. The creation did not verify the mark after saving it. It now reads it back from the account Supabase returned and removes the account if it is missing.
2. The reset set the password and the mark in one call and did not confirm the mark. It now sets and confirms the mark first, then changes the password. If the second call fails the judge is left pending (the old password then only forces a change).

### 40.3 Vercel Preview environment (Preview scope only; values never written here)
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: the DEV project. `RIO_SUPABASE_ALLOWED_REF=rajbfcoxolnjgiqgvflm`.
- `RIO_UPLOADS_ENABLED=no`, `RIO_FINALIZE_ENABLED=no`, `RIO_PLAYBACK_ENABLED=no`, `RIO_EMAIL_ENABLED=no`, `RIO_STAFF_INVITES_ENABLED=no`, `RIO_STAFF_PROVISIONING_ENABLED=no` (or unset: only the exact value `yes` enables anything).
- `SUPABASE_SECRET_KEY` is not needed while provisioning is off, and must not be set in a Preview that also has the switch on until the owner decides to test. No production value in Preview.
- `R2_ACCOUNT_ID` is a build-time value (the Content-Security-Policy). Nothing else R2 is needed while uploads and playback are off.

## 41. Express migration M2B: application schema (2026-11-10), local only

Scope: schema only. Auth, API routes, seed data, the Next apps and every Supabase resource are untouched. Nothing was applied to any hosted database.

### 41.1 What was built
- `backend/migrations/mysql` and `backend/migrations/sqlite`: ten paired files (staff accounts, audit log, events and settings, question sets, submissions and recovery, answers, duplicate reviews, video uploads, judging, e-mail outbox and rate limits). Tables, relationships, invariants, the list of rules that need a transaction in M4/M5, the dialect differences and the unresolved business rules R1 to R13 are in `backend/migrations/README.md`.
- `backend/src/db/schema.ts`: Kysely row types. `adapter.ts` now uses them (`DatabaseSchema`).
- `backend/src/db/readiness.ts`: `checkReadiness()` reports ready / migrations missing / pending / unsafe / unavailable without changing anything. No route uses it yet (`/api/v1/health` stays a liveness check).
- `errors.ts`: trigger-raised rule violations are `constraint` of kind `rule` (MySQL error 1644, SQLite 1811). `reset.ts` also drops views.
- M2A leftovers closed: session `sql_mode` and UTC proven on every pooled MySQL connection (`readiness.test.ts`), SQLite WAL, foreign keys and busy timeout proven on a file database, readiness tested on both engines.

### 41.2 Acceptance evidence (run 2026-11-10 inside `backend/`)
| Check | Result |
|---|---|
| `npm run lint`, `npm run typecheck`, `npm run build` | pass |
| `npm test` with a disposable MySQL 8.0.46 (`RIO_REQUIRE_MYSQL_TESTS=yes`) | 11 files, 447 tests pass |
| `npm test` without MySQL (SQLite only) | 295 pass, 2 skipped (the MySQL-only `sql_mode` tests) |
| `src/db/schema.test.ts` repeated three times on MySQL and SQLite | 224 of 224 each time, no flakiness |
| `npm run db:verify` | "Dialect folders match" |
| `db:migrate`, `db:status`, second `db:migrate` on an empty throw-away MySQL | applied 0001 to 0010; all `applied`; "Nothing to apply" |

### 41.3 Follow-ups (not done, outside M2B)
- The CI `backend` job (MySQL service) has still never run on GitHub.
- An adapter that is closed before its first query connects afresh on its next use; one closed after use refuses (M2A test). Harmless today; worth making uniform before services hold adapters.
- No seed for the six competitions or their question sets; an owner decision and a later module.
- `DEPLOYMENT.md` section 0 and `CLAUDE.md` should be reread when M3 starts; the password-hash algorithm, recovery-code design and the open rules R1 to R13 need owner decisions first.

## 42. Express migration M3: staff authentication (2026-11-10), local only

Scope: backend only. The Next apps still sign staff in through Supabase; nothing was switched over. No migration was added (M2B already had `staff_users`, `staff_sessions`, `audit_log`, `rate_limits`).

### 42.1 Design
- **Passwords:** Argon2id from `node:crypto` (no dependency), stored as a PHC string that records its own cost, upgraded at the next login when the settings rise. Production refuses less than 19456 KiB and 2 passes. NFKC-normalised, 12 to 128 characters, the same rules as the Supabase provisioning code.
- **Sessions:** a 256-bit random token in an HttpOnly, host-only cookie (`__Host-rio_staff` when Secure); the database keeps only its SHA-256. Absolute life 8 h, idle 60 min (both configurable). Every request re-reads the session, the account's `active` flag and its role, so deactivation, demotion and revocation act at once.
- **CSRF and origin:** every state-changing request needs an `Origin` from `ALLOWED_ORIGINS` and an `X-CSRF-Token` that is an HMAC of the session token (no extra column or secret). CORS answers only the allowed origins, with credentials, never `*`.
- **Rate limits:** per IP (30 per 15 min) and per e-mail (8 per 15 min) for login, per account (10 per hour) for password attempts; counters live in `rate_limits` as SHA-256 digests, so all instances share them. Limited callers get 429 whatever the password was.
- **First login:** an account with `must_change_password` can only reach `/me`, `/password` and `/logout`. Changing the password needs the current one, ends every session of the account and issues a new one.
- **Bootstrap:** `npm run staff:create-admin -- --email ... --name ...` (refuses when an active admin exists unless `--additional`) and `staff:reset-password`; a random temporary password is printed once and stored only hashed; in production they need `RIO_CONFIRM_STAFF_CLI=<database name>`.
- **Audit:** `staff.login`, `staff.login_failed` (reason code only), `staff.login_rate_limited` (once per window), `staff.logout`, `staff.password_changed`, `staff.password_change_failed`, `staff.password_reset`, `staff.created`. No password, token, e-mail address or IP address is ever written.
- `createApp` takes the opened database; `server.ts` now opens it at start-up (lazy pool) and closes it on shutdown. `/api/v1/health` is unchanged and still touches nothing.

### 42.2 Evidence (run 2026-11-10 inside `backend/`)
| Check | Result |
|---|---|
| lint, typecheck, build, `db:verify` | pass |
| `npm test` with a disposable MySQL 8.0.46 | 14 files, 642 tests pass |
| `npm test` on SQLite only | 414 pass, 2 skipped (MySQL-only `sql_mode` tests) |
| `src/auth` suite three times on both engines | 181 of 181 each time |
| compiled server smoke run (SQLite file): migrate, create-admin, wrong password 401, foreign origin 403, login, me, forced password change, old cookie 401, logout 204 | pass; no secret in any table or in the server log |

### 42.3 Remaining blockers and follow-ups
- **Not connected:** neither Next app calls these endpoints yet. Wiring `admin/` to them is a separate, approved step; cookies need the admin site and the API on one registrable domain (or `SESSION_COOKIE_SAMESITE=none`), and the API's public origin on Railway is not decided.
- **Per-account limit is a denial-of-service lever:** anyone can send 8 bad attempts for a known staff e-mail and block that person's login for up to 15 minutes. The per-IP limit slows this, nothing prevents it. Accepted for now; limiting per e-mail and IP together would weaken protection against distributed guessing.
- `TRUST_PROXY_HOPS` must be set correctly in production (1 on Railway) or the IP limit sees only the proxy.
- No judge creation, deactivation or reset **endpoints** yet (M5); the service function `resetPassword` and the rules (an inactive judge cannot sign in, sessions are re-checked per request) exist. A judge deactivation must still revoke that judge's sessions in the same transaction (the check already rejects them, but the rows would stay open).
- No periodic purge of expired sessions and old `rate_limits` rows (`RateLimiter.purge` exists; a job does not).
- No concurrent-session cap; a login replaces only the session of the cookie it arrived with.
- The compiled server was exercised on SQLite only; the MySQL path is covered by the integration tests, not by a running server.
- The CI `backend` job has still never run on GitHub.

## 43. Express migration M4: anonymous registration (2026-11-10), local only

Scope: backend only. No OTP and no parent accounts. The Next apps still use Supabase registration; nothing was switched over. Registration is **not open**: `event_settings` is untouched (all NULL), and no code in this module can open it.

### 43.1 Routes (all under `/api/v1`, JSON only, strict bodies)
| Route | Purpose |
|---|---|
| `GET /events` | Active competitions with ages and the bilingual published question set (no ids). |
| `GET /settings/public` | `registrationOpen`, the window, the consent **versions** (never any wording), server time. |
| `POST /registrations` | Creates a draft. Needs an Origin from `PUBLIC_ORIGINS`. Returns the entry reference, the recovery code (once, in six groups of four), a CSRF token, and sets an HttpOnly cookie. |
| `POST /registrations/recover` | Opens an entry on another device with the typed code. One identical 401 for every failure. |
| `GET /registrations/current` | The entry the cookie opens (the owner's own data, with its questions and answers). |
| `PATCH /registrations/current` | Edits a draft: child, guardian, e-mail, consent, answers. Needs Origin and CSRF. |

### 43.2 Security model
- **Only the recovery code opens an entry.** 24 characters of Crockford base32 (120 bits), SHA-256 digest stored (`registration_recovery`), the same value in an HttpOnly, SameSite, host-only cookie (`__Host-rio_reg` when Secure). Lifetime `REGISTRATION_TOKEN_DAYS` (default 30). Not rotated on use. A name, a mobile number or an entry reference is never accepted as a way in.
- **No enumeration.** Creating an entry for a child who already has a submitted entry returns the same status and shape as any other. The duplicate is only recorded, as `duplicate_reviews` status `flagged` (matched against a finalized or held entry with the same normalised child name, mobile and competition). Recovery failures, the cookie check and the rate-limit answers are identical whatever exists.
- **Duplicates.** Never blocked at registration. The database's unique key on `(competition, normalised name, mobile, finalized)` remains the real guard when an entry is finalized (M6/M7), so no race can produce two finalized entries. Siblings on one mobile, the same child in another competition and the same name with another mobile do not match.
- **Normalisation** (`registration/normalize.ts`): NFC and collapsed white space for display text; a separate lower-cased key with joiners removed and `. , ' ’ - _` treated as spaces for matching; mobile numbers reduced to `+91` and ten digits from many written forms, including Tamil and Devanagari digits; e-mail lower-cased. Tamil is never transliterated.
- **Eligibility and consent.** Age is checked against the competition's range (the database trigger repeats it); guardian consent must be an explicit `accepted: true` for the version in force (`409 consent_version_changed` otherwise); media consent is separate and optional (never asked / declined / granted). The registration window is checked on the server at create and at every edit.
- **Origin, CSRF, CORS.** Changes need an Origin from `PUBLIC_ORIGINS` (a separate list from the admin's `ALLOWED_ORIGINS`: the public site can never call a staff route, nor the admin site a registration change). Edits also need the `X-CSRF-Token` returned with every response. CORS answers only the two lists, with credentials, never `*`.
- **Rate limits (shared, in the database):** creation 15 per hour per address and 10 per day per mobile number; recovery 10 per 15 minutes per address; reads 300 per 15 minutes per address; writes 200 per hour per entry. The limiter was made exact under bursts (see 43.4).
- **Privacy.** No name, mobile, e-mail, code or address is written to the audit log, the rate-limit table, the logs or an error. Validation errors name the field and a fixed problem code only. Audit: `registration.created`, `registration.recovered`, `registration.consent_recorded`, `registration.duplicate_flagged` (ids and labels).
- **M3 preserved:** the staff cookie and the registration cookie differ in name and table; each opens nothing on the other side (tested both ways).

### 43.3 Schema change
Migration `0011_optional_guardian_email` makes `submissions.guardian_email` nullable (MySQL `ALTER`; SQLite table rebuild) and fixes the "submitted entry is frozen" trigger to compare it null-safely. The SQLite rebuild needs foreign-key enforcement off, so the migration runner gained an opt-in marker, `-- rio:foreign-keys-off` (enforcement off, `PRAGMA foreign_key_check` before commit, enforcement always restored). Details: `backend/migrations/README.md`.

### 43.4 Defects found and fixed during M4
1. The SQLite rebuild passed on an empty database and **failed on a populated one**; found by the data-preservation test, fixed with the marker above.
2. The M3 rate limiter read the counter after the increment, so in a burst of simultaneous requests every request saw the final total and **all were refused** instead of the first `max`. It now returns its own exact count (MySQL `LAST_INSERT_ID(hits + 1)`, SQLite `RETURNING`). Staff login limits behave the same otherwise (suite re-run).
3. A lone combining mark (a Tamil vowel sign) was accepted as a name; a name must now start with a letter.

### 43.5 Evidence (run 2026-11-10 inside `backend/`)
| Check | Result |
|---|---|
| lint, typecheck, build, `db:verify` | pass |
| `npm test` with a disposable MySQL 8.0.46 | 18 files, 955 tests pass |
| `npm test` on SQLite only | 607 pass, 2 skipped (MySQL-only `sql_mode` tests) |
| `src/registration`, `src/auth`, migration 0011 and runner suites three times on both engines | 487 of 487 each time |
| compiled server smoke run (SQLite file): closed 403, foreign origin 403, age 422, create 201, current, edit with and without CSRF, recovery on a second device in lower case, wrong code 401, recovery limit, edits visible across devices | pass; no code, name, mobile, e-mail or address in any table or log |

### 43.6 Remaining blockers and follow-ups
- **Not connected:** the website still registers through Supabase and OTP. Wiring `website/` (form, code screen, recovery screen) is a separate, approved module. Cookies need the website and the API on one registrable domain, or `SESSION_COOKIE_SAMESITE=none`; the API's public origin is undecided.
- **Delivery of the recovery code:** only the on-screen code exists. With an e-mail address the code could be mailed, but the outbox/provider path is a later module and an owner decision (R5). A parent who loses the code and clears the cookie cannot reopen the draft (by design; they register again).
- **Open rules still undecided:** consent wording (R1, D5), duplicate criteria beyond exact matches (R6: similar names, twins), erasure and retention (R9/R10). No seed data: the six competitions and their question sets must be entered.
- **Not in M4:** video upload (R2), final submission (which also writes answer snapshots and holds a flagged entry for review), administrator duplicate review and settings screens, judge and results work, expired-code and rate-limit purge jobs, `required` question enforcement (reported as `missingRequired`, enforced at submission).
- A second draft can be created for the same child and mobile (the unique key concerns finalized entries only); abandoned drafts are not cleaned up yet.
- `PUBLIC_ORIGINS` empty means every registration change is refused; the server logs `public_origins_not_configured` at start-up.
- The CI `backend` job has still never run on GitHub.

## 44. Docker-free local development on XAMPP MariaDB (2026-11-10), local only

Decision (owner): Docker is not used. Local development runs against the XAMPP database (MariaDB 10.4.32, `127.0.0.1:3306`, database `rio_hospital`). Production stays MySQL 8.

### 44.1 State: partly done, blocked on database credentials
| Task | State |
|---|---|
| Docker removed from the repository | **Done**: the repository never contained a Dockerfile, compose file, script or configuration; the one documentation sentence that recommended a Docker test database was replaced. Not touched: the GitHub Actions `backend` job (it uses a MySQL 8 service that GitHub starts; nothing runs on this machine) and `database/supabase/config.toml` (a comment about the old Supabase local stack). No Docker resource on the computer was touched. |
| MariaDB compatibility | **Written, not run**: `backend/migrations/mariadb/0001..0011` (the reviewed MySQL files with only the two MySQL-8-only collation names replaced; a test enforces this), `DB_ENGINE` setting, server/engine guard, MariaDB CHECK error number 4025, `VALUES(col)` upsert, three-folder parity in `db:verify`. |
| Connection to `rio_hospital`, inspection, tables | **Not done.** The permission system refused every login with a guessed account (`root`, empty password) because no credentials were given, which is correct. Nothing was read from or written to `rio_hospital`: its emptiness is unverified. No `backend/.env.local` was created. |
| Tests on MariaDB | **Not run.** |

One probe (before the permission system stopped further use) showed: XAMPP MySQL is running, port 3306, MariaDB 10.4.32, database `rio_hospital` exists, and the `root` account accepted an empty password (a security risk; see `backend/LOCAL_DEVELOPMENT.md`).

### 44.2 Changes
- `db:status` is now strictly read-only (it used to create the `rio_migrations` table when absent); new `db:ready` (real query + read-only migration check; `GET /api/v1/health` still does not touch the database); `test:local` script (reads `.env.test.local`).
- Test runs print `[rio] MySQL/MariaDB integration tests were NOT RUN` whenever no test database is configured, so a SQLite-only result cannot pass for a MySQL or MariaDB result. `RIO_TEST_DB_ENGINE=mariadb` selects the MariaDB migrations for the test database.
- `backend/LOCAL_DEVELOPMENT.md` explains the workflow, including the SQL the owner runs once in phpMyAdmin (databases `rio_hospital` and `rio_test`, accounts `rio_app` and `rio_test` limited to their own database, no `root` involved).

### 44.3 MySQL 8 and MariaDB: what is and is not evidenced
- MySQL 8.0.46 evidence from M2B to M4 (migrations, constraints, triggers, concurrency, M3, M4: 955 backend tests) was obtained earlier with a temporary test server that no longer exists. It was **not repeated** after the MariaDB changes (`DB_ENGINE`, error mapping, `VALUES(col)` upsert, `db:status` read-only, `db:ready`), which are covered on SQLite and by unit tests only.
- Nothing has run on MariaDB. Known risk points to watch at the first run: expression defaults (`DEFAULT (UTC_TIMESTAMP(3))`), generated columns inside unique keys, `JSON_TYPE`/`JSON_LENGTH` checks on `LONGTEXT`, trigger and CHECK ordering, `REGEXP` (PCRE instead of ICU), `LAST_INSERT_ID(expr)` in the rate limiter, `CREATE OR REPLACE VIEW`, and the SQL-mode session settings. Error handling for a CHECK violation (4025) is mapped but untested against a server.
- The GitHub Actions `backend` job (MySQL 8) has still never run.

## 45. Local development finalisation on XAMPP MariaDB (2026-11-10), local only

State of the local database `rio_hospital` (MariaDB 10.4.32, `127.0.0.1:3306`, `root` without a password, as chosen by the owner): migrations 0001 to 0011 applied from `backend/migrations/mariadb/`; 18 application tables, `rio_migrations`, the `published_winners` view; the six competitions seeded; **registration closed** (every `event_settings` date and consent version empty); no staff, no sessions, no entries, no question sets. `db:status` 11 applied, `db:ready` ready, `db:verify` match.

### 45.1 What was added
- `backend/.env.example` recreated (placeholders only, every name is read by `config.ts`). Secret-bearing files `.env`, `.env.local`, `.env.test.local` are git-ignored (`.gitignore` rules `.env` and `.env.*`).
- `ALLOWED_ORIGINS=http://localhost:3001` (admin) and `PUBLIC_ORIGINS=http://localhost:3000` (public site) appended to `backend/.env.local`; nothing else in the file was changed. The API's own origin (4000) is in neither list. **Defect found and fixed:** the origin parser accepted `http://*` and `http://*.example.org` (the URL parser allows `*` in a host). Matching was always exact string equality, so it never acted as a wildcard, but such entries are now refused at start-up (test `origins.test.ts`).
- `npm run db:seed:events [-- --dry-run]` (`src/db/seed-events.ts`, `seed/competitions.ts`): inserts the six competitions (slug, Tamil and English name, age range, poster order) from `website/lib/events.ts`; idempotent; never overwrites; stops with nothing written if an existing slug differs; leaves organizer-added competitions, order and the active flag alone; refuses production; proves the database identity and migration state first. A test reads `website/lib/events.ts` and fails if the list drifts. The task sentences (`taskTa`/`taskEn`) have no column and were not seeded; no dates, questions or consent text were created.
- `npm run test:mariadb` (`src/db/test-mariadb.ts`, `test-runner-guards.ts`): disposable `rio_<12 hex>_test` database, dedicated account only, drop only after name, run and marker agree. **BLOCKED on this machine: no dedicated test account exists** (exit 3, nothing created, no fallback to root).

### 45.2 Evidence
| Check | Result |
|---|---|
| lint, typecheck, build, `db:verify` | pass |
| `npm test` (SQLite only; no database variables in the shell) | 23 files, 728 pass, 2 skipped (MySQL-only `sql_mode` tests) |
| Seed on `rio_hospital` | dry run, then 6 created, second run "Nothing to do" |
| Running server (the owner's `npm run dev`, port 4000) | `/health` 200; `/settings/public` closed; `/events` exactly the six; CORS answers only 3000 and 3001; staff routes 401/403 without credentials; a complete valid registration from the public origin 403 `registration_closed` |
| Left in the database by the smoke test | 2 rate-limit counters (digest-keyed) and the audit row `events.seeded`; nothing else |

### 45.3 Not tested / blocked
- **MariaDB integration tests: not run** (no dedicated test account). Runtime behaviour on MariaDB of constraints, triggers, the `REGEXP` rules, the rate limiter's `LAST_INSERT_ID` and the `VALUES()` upsert is unverified. MySQL 8 evidence predates these changes.
- Admin account: **not created** (owner has not approved an e-mail address). Judge accounts: none.

### 45.4 Security findings on this machine (nothing was changed)
- MariaDB listens on **all network interfaces** (reachable on the LAN address) and Windows Firewall has two enabled inbound Allow rules named `mysqld` (Public profile).
- All `root` accounts (`localhost`, `127.0.0.1`, `::1`) and `pma` have **no password**; none is a `'%'` account, so remote login as root is not possible, but any program on this computer can read every database on the server, including other projects' (`invictus`, `mypetmart`, `whatnexus`, `pixel_eye_blog_db`).
- Privileges granted with `GRANT` did not survive `FLUSH PRIVILEGES` when tried (suspected: the server's privilege tables are not persisting); the dedicated test account therefore needs a check after a MySQL restart.
- An R2 secret was printed into a session transcript by a faulty check on 2026-11-10 (since rotated by the owner, not verifiable here). `.env` is an extra, unused copy of `.env.local`.

## 46. Local MariaDB security and test validation; frontend readiness (2026-11-10), read-only

Nothing was changed on the machine or in `rio_hospital` (verified by row counts: events 6, audit_log 1, rate_limits 2, rio_migrations 11, everything else 0; registration closed; `rio_hospital` is the only `rio*` database).

### 46.1 Security findings (proposals only; Windows Firewall, root credentials and `my.ini` were not touched)
- MariaDB has no `bind-address`, so it listens on **all interfaces** and accepts connections on the LAN address and the WSL/Hyper-V address. Two enabled inbound Windows Firewall rules named `mysqld` (TCP and UDP, any port, any remote address, **Public** profile) apply, and the active network profile is "Wi-Fi: Public".
- Accounts: `root@localhost`, `root@127.0.0.1`, `root@::1` and `pma@localhost`, **all without a password**. No `'%'` account exists, so a remote login as root is refused, but any program on the computer can read every database on the server (also `invictus`, `mypetmart`, `whatnexus`, `pixel_eye_blog_db`, `rti_saathi`).
- Two inert leftover grants for an anonymous user on `test` and `test\_%`.
- **The XAMPP data folder looks inconsistent.** The 12:54 start-up log reports InnoDB pages "in the future" (98,410,244 against a current 10,336,392: the redo logs do not match the data file), missing tablespace files for `mypetmart_test` and `rti_saathi`, `aria_log_control` is 0 bytes, and `mysql_upgrade_info` is absent (system tables from 2019, server 10.4.32). `rio_hospital` is not named in any error. This is the leading explanation (probable, not proven) for grants not surviving `FLUSH PRIVILEGES`.

### 46.2 Test account and runner
- `npm run test:mariadb` is unchanged and still **BLOCKED** (exit 3): no `RIO_TEST_SERVER_URL`, no dedicated account. No MariaDB integration test has run.
- **Defect found and fixed:** the guide's grant had lost its backslashes (`rio_%_test` instead of `rio\_%\_test`), which would have made each `_` a one-character wildcard. A new test (`test-runner-guards.test.ts`) now reads the guide, requires the exact escaped pattern, forbids `WITH GRANT OPTION` and `ON *.*`, and proves the pattern matches every name the runner generates and none of the other databases on this server.

### 46.3 Evidence
lint, typecheck, build, `db:verify` pass; `npm test` (SQLite only): 23 files, 749 pass, 2 skipped; `db:status` 11 applied; `db:ready` ready.

### 46.4 Frontend readiness
See the report of this session: neither Next app calls the Express API yet (no reference to it anywhere); 17 website and 15 admin non-test files touch Supabase; the recommended next module is M5a (administrator API: event settings, question sets, registrations list and detail), because registration cannot be opened or used until a published question set exists.

## 47. Local administrator sign-in through the Express API (2026-11-10), local only

### 47.1 What changed (admin/ only; backend untouched)
- `admin/lib/api/express.ts`: server-only helper. Calls `RIO_API_ORIGIN` (default `http://127.0.0.1:4000`) from server components and server actions, forwards the session cookie, sends `Origin` = `RIO_ADMIN_ORIGIN` (default `http://localhost:3001`, must be in the API's `ALLOWED_ORIGINS`) and the session's CSRF token on POSTs, and relays only the API's session cookie (`rio_staff`, `__Host-rio_staff` under Secure) to the browser: HttpOnly, SameSite as the API set it. The browser never calls the API, so `connect-src 'self'` is unchanged.
- `/staff/login`, `/staff/set-password` (now asks for the current password too), sign-out, `requireStaff`/`staffSession` use `POST /staff/login`, `GET /staff/me`, `POST /staff/password`, `POST /staff/logout`. `proxy.ts` sends cookie-less visitors from `/admin` and `/judge` to the sign-in (a first gate only; the API is the real check) and sets `no-store`.
- `/admin` shows the signed-in administrator and the six fixed competitions and an explicit "Not available yet" panel instead of counts/settings. Registrations, registration detail, judges, a competition page and the judge pages show the same plain placeholder; the judge/winner/assign server actions return "unavailable" and change nothing. No data is invented.
- Local administrator `admin@rio.local` ("Rio Administrator") created with `npm run staff:create-admin` in `rio_hospital` (temporary password shown once in the terminal, `must_change_password` set).

### 47.2 Not done / follow-ups
- Legacy Supabase modules in admin/ are now unreachable from any page but still present (lib/supabase, lib/judging, lib/staff/{invites,provisioning}, `components/admin/*` forms, e2e fixtures and specs that fake Supabase). Remove when M5a replaces them; the e2e specs for the old flow need rewriting.
- M5a (administrator API: settings, registrations, judges) is the next module. Per-address rate limits see the Next server's address unless the API runs with `TRUST_PROXY_HOPS=1`.
