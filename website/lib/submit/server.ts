import type { SupabaseClient } from "@supabase/supabase-js";
import type { SubmitStep } from "@/components/registration/next-steps";
import { getConsentCopy } from "@/lib/registration/consent";
import { createR2Store, readR2Config } from "@/lib/storage/object-store";
import { createAdminClient } from "@/lib/supabase/admin";
import type { FinalizeDb, FinalizeDeps } from "./service";
import { inspectVideo } from "./inspect";

// Wires final submission to the real bucket and the real database functions. Server-only.

type Env = Record<string, string | undefined>;

/**
 * The master switch for FINAL SUBMISSION. ONLY the exact value "yes" turns it on; missing, empty, "YES", " yes", "true" and
 * "1" are all off. It is separate from the upload switch, and it stays off until server-side media inspection exists (see
 * PROJECT_BRIEF.md, release blocker B1): an equal ETag does not prove what a video contains.
 */
export function finalizeEnabled(env: Env = process.env): boolean {
  return env.RIO_FINALIZE_ENABLED === "yes";
}

/** Everything final submission needs besides the switch: the bucket settings and the secret key. */
export function finalizeConfigured(env: Env = process.env): boolean {
  return readR2Config(env) !== null && Boolean(env.SUPABASE_SECRET_KEY?.trim());
}

/** Final submission is offered and served only when the switch is on AND everything is configured. Checked by the page, by the
 *  server action and again when the dependencies are built, so hiding the button is never the only protection. */
export function finalizeAvailable(env: Env = process.env): boolean {
  return finalizeEnabled(env) && finalizeConfigured(env);
}

/**
 * What the registration page shows for the submit step. Only an entry that is uploaded, with registration open and final
 * submission available, gets the working button; everything else gets the disabled one. (The server action enforces the same
 * rules independently, so this decides what is shown, never what is allowed.)
 */
export function submitStep(
  input: { open: boolean; current: { id: string; status: string; childName: string; childAge: number; mediaConsent: boolean } | null; event: { slug: string; nameTa: string; nameEn: string } },
  env: Env = process.env,
): SubmitStep {
  const { open, current, event } = input;
  if (!open || !current || current.status !== "uploaded" || !finalizeAvailable(env)) return { kind: "off" };
  return { kind: "on", submissionId: current.id, slug: event.slug, childName: current.childName, childAge: current.childAge, eventNameTa: event.nameTa, eventNameEn: event.nameEn, mediaConsent: current.mediaConsent };
}

type CheckRow = { upload_id: string | null; bytes: number | string | null; content_type: string | null; etag: string | null; event_id: number | string; consent_version: string; already: boolean };

export function createFinalizeDb(admin: SupabaseClient): FinalizeDb {
  const fail = (error: { message: string }): never => {
    throw new Error(error.message);
  };
  return {
    async check(owner, submission) {
      const { data, error } = await admin.rpc("check_finalize", { p_owner: owner, p_submission: submission });
      if (error) fail(error);
      const row = (data as CheckRow[] | null)?.[0];
      if (!row || !row.upload_id) throw new Error("video_not_verified");
      return { uploadId: row.upload_id, bytes: Number(row.bytes), type: row.content_type ?? "", etag: row.etag ?? "", eventId: Number(row.event_id), consentVersion: row.consent_version, already: row.already };
    },
    async finalize(owner, submission, upload, bytes, type, etag) {
      const { data, error } = await admin.rpc("finalize_verified_submission", { p_owner: owner, p_submission: submission, p_upload: upload, p_bytes: bytes, p_content_type: type, p_etag: etag });
      if (error) fail(error);
      return data === "already_finalized" ? "already_finalized" : "finalized";
    },
  };
}

export function createFinalizeDeps(): FinalizeDeps {
  if (!finalizeEnabled()) throw new Error("Final submission is switched off."); // last line of defence: nothing is built without the switch
  const cfg = readR2Config();
  if (!cfg) throw new Error("R2 is not configured.");
  const store = createR2Store(cfg);
  return {
    store,
    db: createFinalizeDb(createAdminClient()),
    consentKnown: (version) => getConsentCopy(version) !== null,
    inspect: (key, type, bytes) => inspectVideo(type, bytes, (start, end) => store.readRange(key, start, end)),
  };
}
