import { reg, type Msg } from "./messages";
import type { Field } from "./schemas";

// Maps a database or API error from a registration write to a safe message. The raw error text is never shown
// or logged (it could echo submitted data). Codes come from PostgREST: the SQLSTATE in `code`, or the
// RAISE EXCEPTION text from our own triggers in `message`.

type DbError = { code?: string; message?: string };
export type WriteFailure = { error?: Msg; fieldErrors?: Partial<Record<Field, Msg>> };

export function registrationWriteError(error: DbError, event: { minAge: number; maxAge: number }): WriteFailure {
  const message = error.message ?? "";
  if (message.includes("submissions_closed")) return { error: reg.errors.closed };
  if (message.includes("consent_version_mismatch")) return { error: reg.errors.consentChanged };
  if (message.includes("age_not_eligible")) return { fieldErrors: { childAge: reg.errors.ageBand(event.minAge, event.maxAge) } };
  if (message.includes("submission_locked") || message.includes("invalid_status_transition")) return { error: reg.errors.locked };
  if (error.code === "23505") return { error: reg.errors.duplicate };
  if (error.code === "23514") return { error: reg.errors.fix };
  if (error.code === "42501") return { error: reg.errors.notAllowed };
  return { error: reg.errors.saveFailed };
}
