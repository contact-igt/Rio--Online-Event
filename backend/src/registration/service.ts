import type { Config } from "../config.ts";
import { writeAudit } from "../auth/audit.ts";
import { createRateLimiter, type RateLimiter } from "../auth/rate-limit.ts";
import { RateLimited } from "../auth/staff.ts";
import { sha256Hex } from "../auth/tokens.ts";
import type { DatabaseAdapter, Queryable, SqlValue } from "../db/adapter.ts";
import { DatabaseError } from "../db/errors.ts";
import { asDate } from "../db/values.ts";
import { AppError } from "../http/errors.ts";
import { checkAnswer, missingRequired, type AnswerValue, type Option, type Question, type QuestionType } from "./answers.ts";
import { canonicalCode, newEntryReference, newRecoveryCode } from "./codes.ts";
import { nameKey } from "./normalize.ts";
import { ValidationFailed, type CreateInput, type PatchInput } from "./schemas.ts";

// The registration life cycle for a parent with no account:
//
//   create   one transaction: the entry (a draft bound to the competition's published question set), its recovery code (SHA-256 only), a
//            possible-duplicate flag, and audit rows. The answer to the parent is the same whether or not the child was seen before.
//   read     only with the recovery code (cookie or typed). A name or mobile number opens nothing.
//   update   only while the entry is a draft, the registration window is open, and the code is valid.
//   recover  the code typed on another device; every failure gives one identical answer.
//
// Nothing here ever writes a name, a mobile number, an e-mail address, an address or a code into the audit log or an error.

export type RegistrationDeps = { db: DatabaseAdapter; config: Config; now: () => Date; limiter: RateLimiter };
export const registrationDeps = (db: DatabaseAdapter, config: Config, now: () => Date = () => new Date()): RegistrationDeps => ({ db, config, now, limiter: createRateLimiter(db) });

export const REGISTRATION_LIMITS = {
  createPerIp: { max: 15, windowMs: 60 * 60_000 },
  createPerMobile: { max: 10, windowMs: 24 * 60 * 60_000 },
  recoverPerIp: { max: 10, windowMs: 15 * 60_000 },
  readPerIp: { max: 300, windowMs: 15 * 60_000 },
  writePerEntry: { max: 200, windowMs: 60 * 60_000 },
} as const;

type Rule = { max: number; windowMs: number };
export async function limit(deps: RegistrationDeps, scope: string, value: string, rule: Rule): Promise<void> {
  const { hits, retryAfterSeconds } = await deps.limiter.hit(scope, value, rule.windowMs, deps.now());
  if (hits > rule.max) throw new RateLimited(retryAfterSeconds);
}

const json = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);
const flag = (value: unknown): boolean => Number(value) === 1;
const iso = (value: unknown): string | null => (value === null || value === undefined ? null : asDate(value).toISOString());

// ---- public information --------------------------------------------------------------------------------------------------------------------------

type SettingsRow = { submissions_open_at: unknown; submissions_close_at: unknown; guardian_consent_version: string | null; media_consent_version: string | null };
type Settings = { opensAt: Date | null; closesAt: Date | null; guardianConsentVersion: string | null; mediaConsentVersion: string | null };

async function loadSettings(db: Queryable): Promise<Settings> {
  const row = (await db.query<SettingsRow>("SELECT submissions_open_at, submissions_close_at, guardian_consent_version, media_consent_version FROM event_settings WHERE id = 1")).rows[0];
  return {
    opensAt: row?.submissions_open_at ? asDate(row.submissions_open_at) : null,
    closesAt: row?.submissions_close_at ? asDate(row.submissions_close_at) : null,
    guardianConsentVersion: row?.guardian_consent_version ?? null,
    mediaConsentVersion: row?.media_consent_version ?? null,
  };
}

/** Open only when an administrator has set a window AND a consent version, and now is inside the window. Anything unset means closed. */
const isOpen = (s: Settings, now: Date): boolean =>
  s.opensAt !== null && s.closesAt !== null && s.guardianConsentVersion !== null && now.getTime() >= s.opensAt.getTime() && now.getTime() < s.closesAt.getTime();

export type PublicSettings = {
  registrationOpen: boolean;
  opensAt: string | null;
  closesAt: string | null;
  guardianConsentVersion: string | null;
  mediaConsentVersion: string | null;
  serverTime: string;
};
export async function publicSettings(deps: RegistrationDeps): Promise<PublicSettings> {
  const s = await loadSettings(deps.db);
  const now = deps.now();
  return {
    registrationOpen: isOpen(s, now),
    opensAt: s.opensAt?.toISOString() ?? null,
    closesAt: s.closesAt?.toISOString() ?? null,
    guardianConsentVersion: s.guardianConsentVersion,
    mediaConsentVersion: s.mediaConsentVersion,
    serverTime: now.toISOString(),
  };
}

type QuestionRow = {
  id: number | string; question_set_id: number | string; position: number; question_key: string; type: QuestionType; prompt_ta: string; prompt_en: string;
  help_ta: string | null; help_en: string | null; required: number; options_json: unknown; max_length: number | null; min_number: number | null; max_number: number | null;
};
const QUESTION_COLUMNS = "id, question_set_id, position, question_key, type, prompt_ta, prompt_en, help_ta, help_en, required, options_json, max_length, min_number, max_number";
const toQuestion = (r: QuestionRow): Question => ({
  id: Number(r.id),
  key: r.question_key,
  type: r.type,
  position: Number(r.position),
  promptTa: r.prompt_ta,
  promptEn: r.prompt_en,
  helpTa: r.help_ta,
  helpEn: r.help_en,
  required: flag(r.required),
  options: r.options_json === null || r.options_json === undefined ? null : (json(r.options_json) as Option[]),
  maxLength: r.max_length === null ? null : Number(r.max_length),
  minNumber: r.min_number === null ? null : Number(r.min_number),
  maxNumber: r.max_number === null ? null : Number(r.max_number),
});
/** The question as the parent sees it: no database ids. */
const publicQuestion = (q: Question) => ({
  key: q.key, type: q.type, position: q.position, promptTa: q.promptTa, promptEn: q.promptEn, helpTa: q.helpTa, helpEn: q.helpEn,
  required: q.required, options: q.options, maxLength: q.maxLength, minNumber: q.minNumber, maxNumber: q.maxNumber,
});

export type PublicEvent = { slug: string; nameTa: string; nameEn: string; minAge: number; maxAge: number; questionSet: { version: number; questions: ReturnType<typeof publicQuestion>[] } | null };

export async function listEvents(deps: RegistrationDeps): Promise<PublicEvent[]> {
  const { db } = deps;
  const events = (await db.query<{ id: number | string; slug: string; name_ta: string; name_en: string; min_age: number; max_age: number }>("SELECT id, slug, name_ta, name_en, min_age, max_age FROM events WHERE active = 1 ORDER BY display_order, id")).rows;
  const sets = (await db.query<{ id: number | string; event_id: number | string; version: number | string }>("SELECT id, event_id, version FROM question_sets WHERE status = 'published'")).rows;
  const questions = (await db.query<QuestionRow>(`SELECT ${QUESTION_COLUMNS} FROM questions WHERE question_set_id IN (SELECT id FROM question_sets WHERE status = 'published') ORDER BY question_set_id, position`)).rows;
  return events.map((e) => {
    const set = sets.find((s) => Number(s.event_id) === Number(e.id));
    return {
      slug: e.slug,
      nameTa: e.name_ta,
      nameEn: e.name_en,
      minAge: Number(e.min_age),
      maxAge: Number(e.max_age),
      questionSet: set ? { version: Number(set.version), questions: questions.filter((q) => Number(q.question_set_id) === Number(set.id)).map((q) => publicQuestion(toQuestion(q))) } : null,
    };
  });
}

// ---- reading an entry ----------------------------------------------------------------------------------------------------------------------------

export type Access = { code: string; recoveryId: number; submissionId: number; expiresAt: Date };

/** The entry a recovery code opens, or null for a code that is unknown, expired, revoked or used. The caller must not say which. */
export async function findAccess(deps: RegistrationDeps, typed: string | null): Promise<Access | null> {
  const code = typed === null ? null : canonicalCode(typed);
  if (code === null) return null;
  const row = (
    await deps.db.query<{ recovery_id: number | string; submission_id: number | string; expires_at: unknown }>(
      "SELECT id AS recovery_id, submission_id, expires_at FROM registration_recovery WHERE token_sha256 = ? AND revoked_at IS NULL AND used_at IS NULL",
      [sha256Hex(code)],
    )
  ).rows[0];
  if (!row) return null;
  const expiresAt = asDate(row.expires_at);
  if (expiresAt.getTime() <= deps.now().getTime()) return null;
  return { code, recoveryId: Number(row.recovery_id), submissionId: Number(row.submission_id), expiresAt };
}

export type RegistrationView = {
  reference: string;
  status: string;
  editable: boolean;
  event: { slug: string; nameTa: string; nameEn: string; minAge: number; maxAge: number };
  child: { name: string; age: number };
  guardian: { name: string; mobile: string; email: string | null };
  consent: { guardian: { version: string | null; at: string | null }; media: { granted: boolean | null; version: string | null; at: string | null } };
  questionSet: { version: number; questions: ReturnType<typeof publicQuestion>[] };
  answers: Record<string, AnswerValue>;
  missingRequired: string[];
  createdAt: string | null;
  updatedAt: string | null;
  codeExpiresAt: string;
};

type EntryRow = {
  id: number | string; entry_code: string; status: string; child_name: string; child_age: number; guardian_name: string; guardian_mobile: string; guardian_email: string | null;
  guardian_consent_version: string | null; guardian_consent_at: unknown; media_consent: number | null; media_consent_version: string | null; media_consent_at: unknown;
  created_at: unknown; updated_at: unknown; question_set_id: number | string; event_id: number | string;
  slug: string; name_ta: string; name_en: string; min_age: number; max_age: number; set_version: number | string;
};
const ENTRY_SQL = `SELECT s.id, s.entry_code, s.status, s.child_name, s.child_age, s.guardian_name, s.guardian_mobile, s.guardian_email, s.guardian_consent_version, s.guardian_consent_at,
  s.media_consent, s.media_consent_version, s.media_consent_at, s.created_at, s.updated_at, s.question_set_id, s.event_id, e.slug, e.name_ta, e.name_en, e.min_age, e.max_age, qs.version AS set_version
  FROM submissions s JOIN events e ON e.id = s.event_id JOIN question_sets qs ON qs.id = s.question_set_id WHERE s.id = ?`;

async function loadQuestions(q: Queryable, setId: number): Promise<Question[]> {
  return (await q.query<QuestionRow>(`SELECT ${QUESTION_COLUMNS} FROM questions WHERE question_set_id = ? ORDER BY position`, [setId])).rows.map(toQuestion);
}

export async function loadView(db: Queryable, access: Pick<Access, "submissionId" | "expiresAt">): Promise<RegistrationView> {
  const s = (await db.query<EntryRow>(ENTRY_SQL, [access.submissionId])).rows[0];
  if (!s) throw new AppError(404, "not_found", "Not found.");
  const questions = await loadQuestions(db, Number(s.question_set_id));
  const answerRows = (
    await db.query<{ k: string; question_type: QuestionType; value_text: string | null; value_number: number | null; value_json: unknown }>(
      "SELECT q.question_key AS k, a.question_type, a.value_text, a.value_number, a.value_json FROM entry_answers a JOIN questions q ON q.id = a.question_id WHERE a.submission_id = ?",
      [access.submissionId],
    )
  ).rows;
  const answers: Record<string, AnswerValue> = {};
  for (const a of answerRows) answers[a.k] = a.question_type === "number" ? Number(a.value_number) : a.question_type === "checkboxes" ? (json(a.value_json) as string[]) : (a.value_text ?? "");
  return {
    reference: s.entry_code,
    status: s.status,
    editable: s.status === "draft",
    event: { slug: s.slug, nameTa: s.name_ta, nameEn: s.name_en, minAge: Number(s.min_age), maxAge: Number(s.max_age) },
    child: { name: s.child_name, age: Number(s.child_age) },
    guardian: { name: s.guardian_name, mobile: s.guardian_mobile, email: s.guardian_email },
    consent: {
      guardian: { version: s.guardian_consent_version, at: iso(s.guardian_consent_at) },
      media: { granted: s.media_consent === null ? null : flag(s.media_consent), version: s.media_consent_version, at: iso(s.media_consent_at) },
    },
    questionSet: { version: Number(s.set_version), questions: questions.map(publicQuestion) },
    answers,
    missingRequired: missingRequired(questions, new Set(Object.keys(answers))),
    createdAt: iso(s.created_at),
    updatedAt: iso(s.updated_at),
    codeExpiresAt: access.expiresAt.toISOString(),
  };
}

// ---- duplicates ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Flags (never blocks) an entry that matches one already submitted: the same normalised child name and mobile number in the same competition,
 * where the other entry is finalized or held. The parent is not told. An administrator decides later; finalizing a second entry for the same
 * child is refused by the database's unique key whatever this check found, so a race here cannot let a duplicate through.
 */
async function flagDuplicate(q: Queryable, now: Date, entry: { id: number; eventId: number; norm: string; mobile: string }, requestId: string): Promise<void> {
  const match = (
    await q.query<{ id: number | string }>(
      "SELECT id FROM submissions WHERE event_id = ? AND child_name_norm = ? AND guardian_mobile = ? AND status IN ('finalized', 'held') AND id <> ? ORDER BY CASE WHEN status = 'finalized' THEN 0 ELSE 1 END, id LIMIT 1",
      [entry.eventId, entry.norm, entry.mobile, entry.id],
    )
  ).rows[0];
  if (!match) return;
  if ((await q.query("SELECT 1 AS open FROM duplicate_reviews WHERE submission_id = ? AND status IN ('held', 'flagged')", [entry.id])).rows.length > 0) return;
  try {
    await q.query("INSERT INTO duplicate_reviews (event_id, submission_id, matched_submission_id, status, reason, created_at) VALUES (?, ?, ?, 'flagged', 'same_child_mobile_event', ?)", [entry.eventId, entry.id, Number(match.id), now]);
  } catch (error) {
    if (error instanceof DatabaseError && error.constraint === "unique") return; // a concurrent request flagged it first
    throw error;
  }
  await writeAudit(q, now, { actorType: "public", action: "registration.duplicate_flagged", entityType: "submission", entityId: entry.id, requestId, details: { reason: "same_child_mobile_event" } });
}

// ---- create --------------------------------------------------------------------------------------------------------------------------------------

const closed = () => new AppError(403, "registration_closed", "Registration is not open.");
const consentChanged = () => new AppError(409, "consent_version_changed", "The consent wording has changed. Read it again.");
const unavailable = () => new AppError(409, "competition_unavailable", "This competition cannot take registrations now.");
const notEditable = () => new AppError(409, "not_editable", "This entry can no longer be changed.");

export type Created = { access: Access; reference: string };

export async function createRegistration(deps: RegistrationDeps, input: CreateInput, ctx: { requestId: string }): Promise<Created> {
  const { db } = deps;
  await limit(deps, "registration.create.mobile", input.guardianMobile, REGISTRATION_LIMITS.createPerMobile);

  const now = deps.now();
  const settings = await loadSettings(db);
  if (!isOpen(settings, now)) throw closed();
  if (input.guardianConsent.version !== settings.guardianConsentVersion) throw consentChanged();
  if (input.mediaConsent) {
    if (settings.mediaConsentVersion === null) throw new ValidationFailed([{ field: "mediaConsent", problem: "media_consent_not_offered" }]);
    if (input.mediaConsent.version !== settings.mediaConsentVersion) throw consentChanged();
  }

  const event = (await db.query<{ id: number | string; min_age: number; max_age: number }>("SELECT id, min_age, max_age FROM events WHERE slug = ? AND active = 1", [input.eventSlug])).rows[0];
  if (!event) throw new AppError(404, "event_not_found", "No such competition.");
  if (input.childAge < Number(event.min_age) || input.childAge > Number(event.max_age)) throw new ValidationFailed([{ field: "childAge", problem: "out_of_range" }]);
  const set = (await db.query<{ id: number | string }>("SELECT id FROM question_sets WHERE event_id = ? AND status = 'published'", [Number(event.id)])).rows[0];
  if (!set) throw unavailable();

  const code = newRecoveryCode();
  const expiresAt = new Date(now.getTime() + deps.config.registration.tokenTtlMs);
  const norm = nameKey(input.childName);
  try {
    const made = await db.transaction(async (tx) => {
      let reference = "";
      for (let attempt = 0; ; attempt++) {
        reference = newEntryReference();
        try {
          await tx.query(
            `INSERT INTO submissions (entry_code, event_id, question_set_id, child_name, child_name_norm, child_age, guardian_name, guardian_mobile, guardian_email,
               guardian_consent_version, guardian_consent_at, media_consent, media_consent_version, media_consent_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              reference, Number(event.id), Number(set.id), input.childName, norm, input.childAge, input.guardianName, input.guardianMobile, input.guardianEmail ?? null,
              settings.guardianConsentVersion, now,
              input.mediaConsent ? (input.mediaConsent.granted ? 1 : 0) : null, input.mediaConsent ? settings.mediaConsentVersion : null, input.mediaConsent ? now : null,
              now, now,
            ],
          );
          break;
        } catch (error) {
          if (attempt < 4 && error instanceof DatabaseError && error.constraint === "unique") continue; // the reference was taken: draw another
          throw error;
        }
      }
      const id = Number((await tx.query<{ id: number | string }>("SELECT id FROM submissions WHERE entry_code = ?", [reference])).rows[0]!.id);
      await tx.query("INSERT INTO registration_recovery (submission_id, token_sha256, created_at, expires_at) VALUES (?, ?, ?, ?)", [id, sha256Hex(code), now, expiresAt]);
      await writeAudit(tx, now, {
        actorType: "public", action: "registration.created", entityType: "submission", entityId: id, requestId: ctx.requestId,
        details: { event_id: Number(event.id), media_consent: input.mediaConsent ? (input.mediaConsent.granted ? "granted" : "declined") : "not_asked" },
      });
      await flagDuplicate(tx, now, { id, eventId: Number(event.id), norm, mobile: input.guardianMobile }, ctx.requestId);
      return { id, reference };
    });
    const recovery = (await db.query<{ id: number | string }>("SELECT id FROM registration_recovery WHERE token_sha256 = ?", [sha256Hex(code)])).rows[0]!;
    return { reference: made.reference, access: { code, recoveryId: Number(recovery.id), submissionId: made.id, expiresAt } };
  } catch (error) {
    // The competition or its question set changed between the checks above and the write: tell the parent plainly, keep nothing.
    if (error instanceof DatabaseError && error.constraint !== null && ["rule", "foreign_key"].includes(error.constraint)) throw unavailable();
    throw error;
  }
}

// ---- update --------------------------------------------------------------------------------------------------------------------------------------

export async function updateRegistration(deps: RegistrationDeps, access: Access, patch: PatchInput, ctx: { requestId: string }): Promise<RegistrationView> {
  const { db } = deps;
  await limit(deps, "registration.write", access.code, REGISTRATION_LIMITS.writePerEntry);

  const now = deps.now();
  const entry = (await db.query<EntryRow>(ENTRY_SQL, [access.submissionId])).rows[0];
  if (!entry) throw new AppError(404, "not_found", "Not found.");
  if (entry.status !== "draft") throw notEditable();
  const settings = await loadSettings(db);
  if (!isOpen(settings, now)) throw closed();

  const problems: { field: string; problem: string }[] = [];
  const sets: string[] = [];
  const params: SqlValue[] = [];
  const set = (column: string, value: SqlValue) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };
  let identityChanged = false;
  const consentNote: Record<string, string> = {};

  if (patch.childName !== undefined) {
    set("child_name", patch.childName);
    set("child_name_norm", nameKey(patch.childName));
    identityChanged = true;
  }
  if (patch.childAge !== undefined) {
    if (patch.childAge < Number(entry.min_age) || patch.childAge > Number(entry.max_age)) problems.push({ field: "childAge", problem: "out_of_range" });
    else set("child_age", patch.childAge);
  }
  if (patch.guardianName !== undefined) set("guardian_name", patch.guardianName);
  if (patch.guardianMobile !== undefined) {
    set("guardian_mobile", patch.guardianMobile);
    identityChanged = true;
  }
  if (patch.guardianEmail !== undefined) set("guardian_email", patch.guardianEmail);
  if (patch.guardianConsent !== undefined) {
    if (patch.guardianConsent.version !== settings.guardianConsentVersion) throw consentChanged();
    set("guardian_consent_version", settings.guardianConsentVersion);
    set("guardian_consent_at", now);
    consentNote.guardian = "recorded";
  }
  if (patch.mediaConsent !== undefined) {
    if (patch.mediaConsent === null) {
      set("media_consent", null);
      set("media_consent_version", null);
      set("media_consent_at", null);
      consentNote.media = "cleared";
    } else {
      if (settings.mediaConsentVersion === null) problems.push({ field: "mediaConsent", problem: "media_consent_not_offered" });
      else if (patch.mediaConsent.version !== settings.mediaConsentVersion) throw consentChanged();
      else {
        set("media_consent", patch.mediaConsent.granted ? 1 : 0);
        set("media_consent_version", settings.mediaConsentVersion);
        set("media_consent_at", now);
        consentNote.media = patch.mediaConsent.granted ? "granted" : "declined";
      }
    }
  }

  const writes: { question: Question; value: AnswerValue | null }[] = [];
  if (patch.answers !== undefined) {
    const questions = await loadQuestions(db, Number(entry.question_set_id));
    for (const [key, raw] of Object.entries(patch.answers)) {
      const question = questions.find((q) => q.key === key);
      if (!question) {
        problems.push({ field: `answers.${key}`, problem: "unknown_question" });
        continue;
      }
      const checked = checkAnswer(question, raw);
      if (checked.ok) writes.push({ question, value: checked.value });
      else problems.push({ field: `answers.${key}`, problem: checked.problem });
    }
  }
  if (problems.length > 0) throw new ValidationFailed(problems);

  set("updated_at", now);
  try {
    await db.transaction(async (tx) => {
      const updated = await tx.query(`UPDATE submissions SET ${sets.join(", ")} WHERE id = ? AND status = 'draft'`, [...params, access.submissionId]);
      if (updated.affectedRows !== 1) throw notEditable(); // it was submitted while this request was running
      for (const { question, value } of writes) await writeAnswer(tx, deps.db.dialect, access.submissionId, Number(entry.question_set_id), question, value, now);
      if (Object.keys(consentNote).length > 0) await writeAudit(tx, now, { actorType: "public", action: "registration.consent_recorded", entityType: "submission", entityId: access.submissionId, requestId: ctx.requestId, details: consentNote });
      if (identityChanged) {
        const row = (await tx.query<{ child_name_norm: string; guardian_mobile: string }>("SELECT child_name_norm, guardian_mobile FROM submissions WHERE id = ?", [access.submissionId])).rows[0]!;
        await flagDuplicate(tx, now, { id: access.submissionId, eventId: Number(entry.event_id), norm: row.child_name_norm, mobile: row.guardian_mobile }, ctx.requestId);
      }
    });
  } catch (error) {
    if (error instanceof DatabaseError && error.constraint === "rule") throw notEditable();
    throw error;
  }
  return loadView(db, access);
}

async function writeAnswer(tx: Queryable, dialect: "mysql" | "sqlite", submissionId: number, setId: number, q: Question, value: AnswerValue | null, now: Date): Promise<void> {
  if (value === null) {
    await tx.query("DELETE FROM entry_answers WHERE submission_id = ? AND question_id = ?", [submissionId, q.id]);
    return;
  }
  const text = typeof value === "string" ? value : null;
  const number = typeof value === "number" ? value : null;
  const list = Array.isArray(value) ? JSON.stringify(value) : null;
  const columns = "(submission_id, question_set_id, question_id, question_type, value_text, value_number, value_json, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
  const sql =
    dialect === "mysql"
      ? `INSERT INTO entry_answers ${columns} ON DUPLICATE KEY UPDATE value_text = VALUES(value_text), value_number = VALUES(value_number), value_json = VALUES(value_json), answered_at = VALUES(answered_at)`
      : `INSERT INTO entry_answers ${columns} ON CONFLICT (submission_id, question_id) DO UPDATE SET value_text = excluded.value_text, value_number = excluded.value_number, value_json = excluded.value_json, answered_at = excluded.answered_at`;
  await tx.query(sql, [submissionId, setId, q.id, q.type, text, number, list, now]);
}

// ---- recover -------------------------------------------------------------------------------------------------------------------------------------

/** One answer for every way a recovery can fail: unknown, mistyped, expired, revoked or used. */
export const recoveryFailed = () => new AppError(401, "recovery_failed", "That code did not work.");

export async function recover(deps: RegistrationDeps, typed: string, ctx: { ip: string; requestId: string }): Promise<Access> {
  await limit(deps, "registration.recover.ip", ctx.ip, REGISTRATION_LIMITS.recoverPerIp);
  const access = await findAccess(deps, typed);
  if (!access) throw recoveryFailed();
  await writeAudit(deps.db, deps.now(), { actorType: "public", action: "registration.recovered", entityType: "submission", entityId: access.submissionId, requestId: ctx.requestId });
  return access;
}
