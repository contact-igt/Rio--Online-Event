# Database migrations

One folder per engine (`mysql/` for MySQL 8, `mariadb/` for the local XAMPP MariaDB, `sqlite/`) with the same versions and names in all of them. File name: `0001_snake_case.sql`.
Statements are separated by a line containing only `--> statement-breakpoint`.

- Never edit a file after it has been applied anywhere: the checksum is recorded and `db:migrate` refuses to run. Add a new version instead.
- MySQL commits DDL implicitly, so a half-failed MySQL migration is not rolled back. Keep each file to one logical change and prefer `IF NOT EXISTS`
  (tables) or `DROP ... IF EXISTS` before `CREATE` (triggers, views).
- SQLite runs each file in one transaction.
- `npm run db:verify` checks that both folders match. Production runs need `RIO_CONFIRM_MIGRATE=<database name>` for that one command.

## Application schema (0001 to 0010 from M2B, 0011 from M4)

M2B was schema only: no Auth, no API, no seed data. The six competitions, their age ranges, the question sets and every date are data that an
administrator or a later module enters; nothing here invents an event date or a consent text. Row types for Kysely: `src/db/schema.ts`.

| Migration | Tables (and view) | Purpose |
|---|---|---|
| 0001 staff_accounts | `staff_users`, `staff_sessions` | Administrators and judges. Password hash only; session cookie only as a SHA-256 digest. Parents have no account. |
| 0002 audit_log | `audit_log` | Append-only (update and delete are refused by triggers). Ids and states only, never personal data. |
| 0003 events_and_settings | `events`, `event_settings` | The competitions (age range per competition). One settings row (`id = 1`): registration window, results time, guardian and media consent *versions*. Created empty = registration closed. |
| 0004 question_sets | `question_sets`, `questions` | Versioned bilingual questions; seven types. Immutable once published. |
| 0005 submissions | `submissions`, `registration_recovery` | One row per child entry; static child and guardian fields; consent records; recovery code digests. |
| 0006 entry_answers | `entry_answers` | One answer per question, typed, with a snapshot of what the parent saw. |
| 0007 duplicate_reviews | `duplicate_reviews` | `held`, `flagged`, `approved`, `rejected`, with decider and audit link. |
| 0008 video_uploads | `video_uploads` (+ trigger on `submissions`) | Upload life cycle; one current (verified) video per entry; an entry cannot be submitted without one. |
| 0009 judging | `judge_profiles`, `judge_assignments`, `scores`, `winners`, view `published_winners` | Assignment, scoring, winners, and the only thing the public may read. |
| 0010 email_and_rate_limits | `email_outbox`, `rate_limits` | Confirmation e-mail queue; hashed-key counters. |
| 0011 optional_guardian_email | `submissions` (column made nullable) | The guardian's e-mail address is optional (M4, no parent accounts). MySQL: `ALTER TABLE`. SQLite has to rebuild the table; the file starts with `-- rio:foreign-keys-off` so the runner uses the SQLite-documented procedure (enforcement off, `foreign_key_check` before commit, enforcement back on). The "submitted entry is frozen" trigger now compares the address null-safely. |

### Relationships

```
events 1─* question_sets 1─* questions
events 1─* submissions *─1 question_sets            (composite FK: the set must belong to the same event)
submissions 1─* entry_answers *─1 questions          (two composite FKs: same set; stored type = the question's type)
submissions 1─* registration_recovery | video_uploads | duplicate_reviews (twice: entry and matched entry, same event) | email_outbox
staff_users 1─0..1 judge_profiles (composite FK on (id, role='judge'))
judge_profiles 1─* judge_assignments *─1 submissions  (composite FK: the assignment names the entry's event)
judge_assignments 1─0..1 scores                       (composite FK on (judge, entry): no assignment, no score)
submissions 1─0..1 winners                            (composite FK on (entry, event))
staff_users 1─* audit_log, staff_sessions, ...        (every "who" column is a FK)
```
Every foreign key is `RESTRICT`: nothing disappears because a parent row was removed. There is no `ON DELETE CASCADE` anywhere.

### Invariants the database enforces (each has a test in `src/db/schema.test.ts`, on both engines)

| Rule | How |
|---|---|
| Age eligibility | `BEFORE INSERT/UPDATE` trigger on `submissions` compares `child_age` with the competition's `min_age`/`max_age`. |
| Entry, question set and competition agree | Composite FKs `(question_set_id, event_id)` and, for answers, `(submission, set)` and `(set, question, type)`. Insert trigger also requires the set to be `published`. |
| One finalized entry per normalised child name + mobile + competition | Unique key `(event_id, child_name_norm, guardian_mobile, finalized_flag)`; `finalized_flag` is a generated column that is 1 only when `status = 'finalized'`, NULL otherwise (NULLs never collide). |
| Siblings, several competitions, drafts | Allowed: different `child_name_norm` or different `event_id` do not collide, and non-finalized rows are never part of the key. A withdrawn entry makes room again. |
| Valid statuses and paths | CHECK on every status column; triggers allow only `draft→held→finalized→withdrawn` (and `draft→finalized`, `held→rejected`, `draft→withdrawn`, `held→withdrawn`). |
| A submitted entry cannot be edited | Trigger freezes identity, consent, competition and set once `status <> 'draft'`; answers and uploads follow the same rule. |
| An entry needs a verified video to be held or finalized | Trigger on `submissions` (0008). |
| Guardian consent is required to submit; media consent is optional and separate | CHECKs. `media_consent` NULL = never asked, 0 = declined, 1 = given; its version and time travel with it. |
| One published question set per competition; published sets and their questions never change | Generated flag + unique key; triggers on `question_sets` and `questions`. A new wording is a new version. |
| Answers match their question's type | `value_text` / `value_number` / `value_json` CHECK per `question_type`; instructions take no answer. |
| One active recovery code per entry; digests only; draft entries only | Unique key on a generated flag; CHECK 64 lower-case hex; insert trigger. |
| One open duplicate review per entry; decisions are complete and immutable | Unique key on a generated flag; CHECKs; update/delete triggers. |
| One current video per entry; life cycle; no replacement after submission | Generated flag + unique key; triggers. |
| Scores only through an assignment; final scores locked | Composite FK; trigger; unlock needs `unlocked_by` and `unlocked_at`. |
| Winners need a finalized entry, one per place and entry | Trigger; unique keys. |
| Results publication | `published_winners` (the only public read) shows rows only when `results_publish_at <= now`. The time cannot be set in the past, cannot be changed once reached, and winners cannot be added, changed or removed after it. The time cannot precede the registration close, and registration cannot open without a close time and a consent version. |
| `audit_log` is append-only | Triggers. |
| Mobile numbers are `+91` followed by ten digits starting 6-9; e-mails lower-case | CHECK. |

A violation of a trigger rule surfaces as `DatabaseError { kind: "constraint", constraint: "rule" }` (MySQL `SIGNAL 45000`, SQLite `RAISE(ABORT)`).
Triggers fire **before** CHECK constraints, so a row that breaks both reports `rule`.

### What the database cannot do alone: transaction-level work for M4 and M5

These are not enforced by constraints on purpose. Each needs one transaction (and, on MySQL, the locking noted) in the service that owns it.

1. **Finalize an entry (M4).** In one transaction: check the registration window and `events.active` against `event_settings`; check that the guardian consent version equals the current setting; check every required question is answered, option codes exist in `options_json`, numbers are inside `min_number`/`max_number`, text is inside `max_length`; write `snapshot_json` for each answer; verify the R2 object and mark the upload `verified` (supersede any earlier one first); look for a finalized entry with the same key and, if found, create a `duplicate_reviews` row and move the entry to `held` instead; otherwise set `finalized`; insert the `email_outbox` and `audit_log` rows. The unique key makes a lost race fail with `constraint/unique` (or `deadlock` on MySQL, which is retryable): the loser must be told, not retried blindly.
2. **Approve a held duplicate (M4/M5).** One transaction: set the review decision (`decided_by`, `decided_at`, note, `audit_log_id`) and move the entry `held → finalized` (or `rejected`). Approval can still fail on the unique key if the earlier entry is still finalized: the administrator must then reject, or withdraw the earlier one first.
3. **Redeem a recovery code (M4).** Hash the presented code, look it up by digest, check `expires_at`, `used_at`, `revoked_at`; count failures in `failed_attempts` and in `rate_limits`; mark `used_at` or issue the next code in the same transaction. Human-typable codes have little entropy: the attempt limit and the lock-out are the real protection, not the hash.
4. **Publish a question set (M5).** Retire the currently published set, then publish the new one, in that order and in one transaction (the unique key forbids two at once).
5. **Deactivate a judge (M5).** Set `staff_users.active = 0` and set `revoked_at` on every session in one transaction; the database does not cascade. A deactivated judge cannot be assigned or start a new score, but may still update an existing draft score: the application must stop that.
6. **Unlock a score (M5).** Set `unlocked_by`/`unlocked_at` and write `audit_log` in one transaction.
7. **Approve winners (M5).** Check that every assigned judge has a final score (the rule is undecided, R3), resolve ties by an explicit human decision (R4), then insert `winners` and `audit_log` together.
8. **Normalisation (M4).** Before any insert: names NFC, case-folded, spaces collapsed and trimmed into `child_name_norm`; mobile numbers reduced to `+91` and ten digits; e-mail lower-cased. The database compares code points exactly and does not normalise, so two spellings of one Tamil letter are different keys unless the application normalises (asserted in the tests).
9. **Bookkeeping.** `updated_at` is set by the application. Expired sessions, recovery codes and `rate_limits` windows are purged by a job.
10. **Erasure.** Deleting a submitted entry is refused (withdraw it first), upload rows are never deleted (mark them `deleted`), and the video object in R2 needs its own deletion step. A written erasure procedure is still to be agreed (R9, R10).
11. **Rate limiting.** `rate_limits` only stores counters; the increment-and-check logic (an atomic upsert, different on each engine) belongs to the service.

### Dialect differences (pinned by tests)

| Topic | MySQL 8 | SQLite |
|---|---|---|
| JSON columns | native `JSON`; read back parsed | `TEXT` with `json_valid` CHECK; read back as text |
| Timestamps | `DATETIME(3)`, UTC; read back as `Date` | ISO-8601 text with `Z`; must be written through the adapter (it formats `Date`) so comparisons in CHECKs and triggers sort correctly |
| Text collation | `utf8mb4_0900_ai_ci` for display text; `utf8mb4_0900_bin` (exact, no padding) for every key, code, digest, normalised name | `BINARY` everywhere |
| Length limits | `VARCHAR(n)` enforced in characters; over-long input is `constraint/other` before any CHECK | repeated as `length()` CHECKs, so `constraint/check` |
| E-mail and slug shape | `REGEXP` (a tab inside an e-mail is refused) | `LIKE`/`GLOB` approximation (a tab is accepted); the application validates addresses either way |
| Row locks | InnoDB row and gap locks; concurrent unique races may report `deadlock` to the loser | whole-database write lock; the loser waits (`busy_timeout` 5 s) and then sees the unique violation |
| DDL | not transactional | transactional |
| Triggers | `SIGNAL`; `DROP TRIGGER IF EXISTS` before `CREATE` | `RAISE(ABORT)` |
| Numbers | marks are whole hundredths (`INT`), exact on both; `DOUBLE`/`REAL` for numeric answers | same |

### Unresolved business rules (nothing here is decided; each is a choice the schema can accommodate)

- **R1 Consent.** Wording, versions, and whether withdrawal is possible are undecided (D5). Only version labels are stored; the text stays in code.
- **R2 Results date.** The old Supabase schema forbade a publish time before 14 November 2026; M2B does not hard-code any date. The owner decides whether to add such a minimum as a later migration.
- **R3 Judging rubric.** The 0-100 scale, number of judges per entry and what counts as "complete" are undecided (D8).
- **R4 Ties.** No rule. The old design flagged ties for a human decision.
- **R5 Recovery.** Channel (e-mail, SMS, shown once on screen), code format, lifetime and attempt limit are undecided. The table supports any of them.
- **R6 Duplicate criteria.** The unique key catches the same normalised name + mobile + competition. Whether near-matches (`similar_name`), twins with the same name, or a shared mobile across guardians should be held or flagged is undecided.
- **R7 Settings scope.** One global settings row is used (as in the old design). Per-competition windows would need a different table.
- **R8 Takedown after publication.** The database refuses to change published winners. A takedown therefore needs a deliberate administrative procedure (not yet designed).
- **R9 Media-consent withdrawal and erasure requests** after submission.
- **R10 Video retention** and deletion of the R2 object.
- **R11 Password hashing** algorithm and parameters (Auth module M3); the column only requires 20 to 255 characters.
- **R12 Publishing a child's name.** `winners.display_name` is typed by an administrator; whether it needs the media consent is undecided.
- **R13 Age bounds.** `events` allows 1 to 18 as a sanity range; the real range per competition is data to be entered.

### The `-- rio:foreign-keys-off` marker (SQLite only)

SQLite cannot change some column rules in place, and rebuilding a table that other tables point at needs foreign-key enforcement OFF, which the
engine allows only outside a transaction. A SQLite migration can ask for that with the line `-- rio:foreign-keys-off`. The runner then switches
enforcement off, runs BEGIN and the statements, runs `PRAGMA foreign_key_check` (any row refuses the migration and rolls it back), commits, and
switches enforcement on again whatever happened. MySQL ignores the marker. Do not use it for anything else. Tests: `migrate-foreign-keys.test.ts`,
and `migration-0011.test.ts` applies 0011 to a database full of related rows.

### The `mariadb/` folder (local development on XAMPP; production is MySQL 8)

`mariadb/` is the reviewed `mysql/` text with only two collation names changed, because MariaDB 10.4 has no `0900` collations: `utf8mb4_0900_bin` becomes
`utf8mb4_nopad_bin` (exact comparison, no trailing-space padding: the same rule for keys, codes, digests and normalised names) and `utf8mb4_0900_ai_ci`
becomes `utf8mb4_unicode_ci` (display text only). A test (`engine.test.ts`) fails if any other character differs, and `db:verify` checks the three folders
define the same migrations. Select it with `DB_ENGINE=mariadb`; production refuses that setting. The files carry a header saying they have not yet run on a
real MariaDB server; remove that line only after `npm run test:local` has passed against one.

| Topic | MySQL 8 | MariaDB 10.4 |
|---|---|---|
| Exact (no-pad) collation | `utf8mb4_0900_bin` | `utf8mb4_nopad_bin` |
| Display-text collation | `utf8mb4_0900_ai_ci` | `utf8mb4_unicode_ci` (pads with spaces; irrelevant for display text) |
| `JSON` columns | native type, returned parsed | alias for `LONGTEXT` with a validity check, returned as text (the code parses strings either way) |
| `REGEXP` | ICU | PCRE: the patterns used here (character classes, `{n}`, anchors) are written to mean the same in both |
| CHECK violation error number | 3819 | 4025 (both map to `constraint/check`) |
| `INSERT ... ON DUPLICATE KEY UPDATE` | `VALUES(col)` is deprecated but works | `VALUES(col)`; the row-alias form (`AS new`) does not exist, so the code uses `VALUES(col)` |
| `CREATE TRIGGER`, `SIGNAL`, generated columns, composite foreign keys, expression defaults, `CREATE OR REPLACE VIEW` | supported | supported (10.2 and later); behaviour unverified until a run |

`db:status` never writes (not even the `rio_migrations` table); `db:ready` runs a real query and checks the migration records without writing.
