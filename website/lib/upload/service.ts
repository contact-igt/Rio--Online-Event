import { z } from "zod";
import { pendingKey, videoKey, type ObjectStore } from "@/lib/storage/object-store";
import { checkVideo, MAX_VIDEO_BYTES, type UploadErrorCode, type VideoMeta } from "./rules";

export type { UploadErrorCode };

// The server side of a video upload, with its dependencies passed in so the tests can use fakes for R2 and the
// database. Nothing here logs, and nothing returns an object key: the browser gets a presigned URL and an opaque id.
//
//   startUpload   checks the declaration, asks the database for a single-use authorization (which re-checks that the
//                 entry is the parent's own, still a draft or uploaded, and that registration is open), then signs
//                 a 15-minute PUT for pending/<id>.
//   finishUpload  1. check_video_upload: the database confirms the authorization is this parent's own, unused, unexpired and
//                    that the entry is still open for a video. A stranger, a stale or an unknown id is turned away HERE,
//                    before the bucket is contacted, and gets the same answer for "not yours" as for "does not exist".
//                 2. HeadObject on the object that authorization names, compared with what it declared (size, type).
//                 3. A conditional copy to videos/<id>, only if the object is unchanged since step 2.
//                 4. attach_video_upload re-checks everything under locks and attaches. It never finalizes the entry.

export const UPLOAD_URL_SECONDS = 15 * 60;

export type UploadDb = {
  /** Read-only authorization check; resolves with what was declared, or throws a database error code. Run before R2 is contacted. */
  check(owner: string, upload: string): Promise<{ bytes: number; type: string }>;
  issue(owner: string, submission: string, type: string, bytes: number): Promise<{ uploadId: string; expiresAt: string }>;
  attach(owner: string, upload: string, bytes: number, type: string, etag: string): Promise<{ replaced: string | null }>;
  reject(owner: string, upload: string, status: "rejected" | "abandoned"): Promise<void>;
};

export type UploadDeps = { store: ObjectStore; db: UploadDb };

export type Failure = { ok: false; code: UploadErrorCode };
export type Started = { ok: true; uploadId: string; url: string; contentType: string; expiresAt: string };
export type Finished = { ok: true; replaced: boolean };

const uuid = z.uuid();
const metaSchema = z.object({ type: z.string().max(100), bytes: z.number().int().positive(), seconds: z.number().min(0).max(24 * 3600).nullable() });

/** Maps a database exception to a code the screen can explain. Unknown errors become "unavailable". */
export function codeFromDbError(error: { message?: string } | null | undefined): UploadErrorCode {
  const m = error?.message ?? "";
  if (m.includes("not_found")) return "notFound";
  if (m.includes("submissions_closed")) return "closed";
  if (m.includes("submission_locked")) return "locked";
  if (m.includes("too_many_uploads")) return "tooMany";
  if (m.includes("upload_not_current")) return "notCurrent";
  if (m.includes("upload_expired")) return "expired";
  if (m.includes("size_mismatch") || m.includes("type_mismatch")) return "mismatch";
  if (m.includes("invalid_video")) return "invalid";
  return "unavailable";
}

export async function startUpload(deps: UploadDeps, input: { ownerId: string; submissionId: unknown; meta: unknown }): Promise<Started | Failure> {
  const submission = uuid.safeParse(input.submissionId);
  const meta = metaSchema.safeParse(input.meta);
  if (!submission.success || !meta.success) return { ok: false, code: "invalid" };
  const declared: VideoMeta = meta.data;
  const problem = checkVideo(declared);
  if (problem) return { ok: false, code: problem };

  let issued: { uploadId: string; expiresAt: string };
  try {
    issued = await deps.db.issue(input.ownerId, submission.data, declared.type, declared.bytes);
  } catch (e) {
    return { ok: false, code: codeFromDbError(e as { message?: string }) };
  }
  try {
    const url = await deps.store.presignPut(pendingKey(issued.uploadId), { contentType: declared.type, expiresInSeconds: UPLOAD_URL_SECONDS });
    return { ok: true, uploadId: issued.uploadId, url, contentType: declared.type, expiresAt: issued.expiresAt };
  } catch {
    await deps.db.reject(input.ownerId, issued.uploadId, "abandoned").catch(() => undefined); // never leave a usable authorization behind
    return { ok: false, code: "unavailable" };
  }
}

export async function finishUpload(deps: UploadDeps, input: { ownerId: string; uploadId: unknown }): Promise<Finished | Failure> {
  // 1. the id must be a uuid: anything else never reaches the database or the bucket
  const parsed = uuid.safeParse(input.uploadId);
  if (!parsed.success) return { ok: false, code: "invalid" };
  const id = parsed.data;

  // 2. authorize BEFORE contacting R2: owner, unused, unexpired, entry open
  let declared: { bytes: number; type: string };
  try {
    declared = await deps.db.check(input.ownerId, id);
  } catch (e) {
    return { ok: false, code: codeFromDbError(e as { message?: string }) };
  }

  const dead = async (status: "rejected" | "abandoned") => {
    await deps.db.reject(input.ownerId, id, status).catch(() => undefined);
    await deps.store.remove(pendingKey(id)).catch(() => undefined);
    await deps.store.remove(videoKey(id)).catch(() => undefined);
  };

  // 3. only now look at the bucket, and only at the one object this authorization names
  let head;
  try {
    head = await deps.store.head(pendingKey(id));
  } catch {
    return { ok: false, code: "unavailable" };
  }
  if (!head || !head.etag) return { ok: false, code: "missing" }; // not (fully) uploaded; the parent starts again with a fresh authorization
  if (head.bytes > MAX_VIDEO_BYTES) {
    await dead("rejected");
    return { ok: false, code: "tooBig" };
  }
  if (head.bytes !== declared.bytes || head.contentType !== declared.type) {
    await dead("rejected");
    return { ok: false, code: "mismatch" };
  }

  // 4. copy only if the object is still the one that was checked
  try {
    await deps.store.copy(pendingKey(id), videoKey(id), head.etag);
  } catch {
    await dead("rejected");
    return { ok: false, code: "mismatch" };
  }

  // 5. the database re-checks authorization, status and the window under locks, and attaches
  try {
    const { replaced } = await deps.db.attach(input.ownerId, id, head.bytes, head.contentType, head.etag);
    await deps.store.remove(pendingKey(id)).catch(() => undefined); // best effort; a lifecycle rule also empties pending/
    return { ok: true, replaced: replaced !== null };
  } catch (e) {
    const code = codeFromDbError(e as { message?: string });
    if (code !== "notFound" && code !== "notCurrent") await dead("rejected"); // do not leave the copied object or a live authorization
    return { ok: false, code };
  }
}
