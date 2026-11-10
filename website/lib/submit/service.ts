import { z } from "zod";
import { videoKey, type ObjectStore } from "@/lib/storage/object-store";
import type { Inspection } from "./inspect";

// Final submission of one entry, with its dependencies passed in so tests can use fakes for the bucket and the database.
// Nothing here logs, and nothing returns an object key, an ETag or a URL.
//
//   1. check_finalize (database): is this the parent's own entry, uploaded, inside the window, with consent recorded and a
//      verified video of its own? A stranger, a draft, a closed window or an unverified video is turned away HERE, before
//      the bucket is contacted, with the same answer for "not yours" as for "does not exist".
//   2. the entry must belong to the competition the page showed, and its consent wording must be one the app knows.
//   3. HeadObject on the verified object (videos/<id>, the id coming from the database, never from the browser): it must
//      still exist, and its CURRENT size, type and ETag must equal the verified record.
//   4. finalize_verified_submission (database): re-checks everything under row locks and makes the one atomic transition.
//
// WHAT THIS DOES NOT PROVE: an equal ETag shows the stored bytes are the bytes that were verified at upload. It does not show
// what the video contains, which container or codec it uses, or how long it is. No media inspection exists yet.

export type FinalizeRecord = { uploadId: string; bytes: number; type: string; etag: string; eventId: number; consentVersion: string; already: boolean };

export type FinalizeDb = {
  /** Read-only authorization check; resolves with the verified record or throws a database error code. Runs before R2 is contacted. */
  check(owner: string, submission: string): Promise<FinalizeRecord>;
  /** The single atomic transition. Resolves "finalized" or "already_finalized", or throws a database error code. */
  finalize(owner: string, submission: string, upload: string, bytes: number, type: string, etag: string): Promise<"finalized" | "already_finalized">;
};

export type FinalizeDeps = {
  store: Pick<ObjectStore, "head">;
  db: FinalizeDb;
  consentKnown: (version: string) => boolean;
  /** Bounded look at the stored file (see inspect.ts). Always provided by createFinalizeDeps; optional here so unit tests can omit it. */
  inspect?: (key: string, type: string, bytes: number) => Promise<Inspection>;
};

export type FinalizeErrorCode =
  | "invalid"
  | "notFound"
  | "status"
  | "closed"
  | "locked"
  | "noVideo"
  | "videoNotVerified"
  | "videoMissing"
  | "videoChanged"
  | "videoInvalid"
  | "videoDuration"
  | "consent"
  | "duplicate"
  | "tooMany"
  | "unavailable";

export type FinalizeFailure = { ok: false; code: FinalizeErrorCode };
export type Finalized = { ok: true; already: boolean };

const uuid = z.uuid();

/** Maps a database exception to a code the screen can explain. Unknown errors become "unavailable". */
export function finalizeCodeFromDbError(error: { message?: string } | null | undefined): FinalizeErrorCode {
  const m = error?.message ?? "";
  if (m.includes("not_found")) return "notFound";
  if (m.includes("invalid_status_transition")) return "status";
  if (m.includes("submissions_closed")) return "closed";
  if (m.includes("submission_locked")) return "locked";
  if (m.includes("video_missing")) return "noVideo";
  if (m.includes("video_not_verified")) return "videoNotVerified";
  if (m.includes("video_changed")) return "videoChanged";
  if (m.includes("consent_missing")) return "consent";
  if (m.includes("duplicate_entry")) return "duplicate";
  return "unavailable";
}

export async function finalizeEntry(deps: FinalizeDeps, input: { ownerId: string; submissionId: unknown; eventId: number }): Promise<Finalized | FinalizeFailure> {
  const id = uuid.safeParse(input.submissionId);
  if (!id.success) return { ok: false, code: "invalid" };

  // 1. authorize in the database first
  let record: FinalizeRecord;
  try {
    record = await deps.db.check(input.ownerId, id.data);
  } catch (e) {
    return { ok: false, code: finalizeCodeFromDbError(e as { message?: string }) };
  }

  // 2. the right competition (the page's, not whatever the request claims) and a consent wording the app recognises
  if (record.eventId !== input.eventId) return { ok: false, code: "notFound" };
  if (!deps.consentKnown(record.consentVersion)) return { ok: false, code: "consent" };

  // an entry that is already final: answered, not repeated (no bucket request, no state change)
  if (record.already) return { ok: true, already: true };

  // 3. the private object must still be the one that was verified
  let head;
  try {
    head = await deps.store.head(videoKey(record.uploadId));
  } catch {
    return { ok: false, code: "unavailable" }; // the bucket could not be asked: nothing changes, the parent can try again
  }
  if (!head || !head.etag) return { ok: false, code: "videoMissing" };
  if (head.bytes !== record.bytes || head.contentType !== record.type || head.etag !== record.etag) return { ok: false, code: "videoChanged" };

  // 4. the stored file must really look like the video it claims to be (header level only, see inspect.ts)
  if (deps.inspect) {
    let seen: Inspection;
    try {
      seen = await deps.inspect(videoKey(record.uploadId), head.contentType, head.bytes);
    } catch {
      return { ok: false, code: "unavailable" }; // the bucket failed while reading: nothing changes, the parent can try again
    }
    if (!seen.ok) return { ok: false, code: seen.reason === "tooShort" || seen.reason === "tooLong" ? "videoDuration" : "videoInvalid" };
  }

  // 5. the atomic transition, which repeats the authorization and the comparison under locks
  try {
    const result = await deps.db.finalize(input.ownerId, id.data, record.uploadId, head.bytes, head.contentType, head.etag);
    return { ok: true, already: result === "already_finalized" };
  } catch (e) {
    return { ok: false, code: finalizeCodeFromDbError(e as { message?: string }) };
  }
}
