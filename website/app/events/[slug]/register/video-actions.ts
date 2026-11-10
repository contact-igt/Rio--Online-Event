"use server";

import { createLimiter } from "@/lib/auth/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { finishUpload, startUpload, type Failure, type Finished, type Started } from "@/lib/upload/service";
import { createUploadDeps, uploadsAvailable } from "@/lib/upload/server";

// Video upload for a registered entry. The parent is identified from their own signed-in session, never from the form;
// the entry's owner, status and the registration window are re-checked inside the database. Nothing here logs, and no
// result contains an object key, a secret or any child detail. The presigned URL in a result is a temporary bearer
// credential for one object: it is returned to the browser that asked for it and nowhere else.

const startByUser = createLimiter(10, 10 * 60_000);
const finishByUser = createLimiter(30, 10 * 60_000);

async function parent(): Promise<string | null> {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser(); // verified with Supabase, not just read from the cookie
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

export async function requestVideoUpload(input: { submissionId: string; type: string; bytes: number; seconds: number | null }): Promise<Started | Failure> {
  if (!uploadsAvailable()) return { ok: false, code: "unavailable" }; // switched off or not configured: nothing else runs
  const owner = await parent();
  if (!owner) return { ok: false, code: "notFound" };
  if (!startByUser.hit(owner).allowed) return { ok: false, code: "tooMany" };
  try {
    return await startUpload(createUploadDeps(), { ownerId: owner, submissionId: input?.submissionId, meta: { type: input?.type, bytes: input?.bytes, seconds: input?.seconds } });
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

export async function confirmVideoUpload(input: { uploadId: string }): Promise<Finished | Failure> {
  if (!uploadsAvailable()) return { ok: false, code: "unavailable" };
  const owner = await parent();
  if (!owner) return { ok: false, code: "notFound" };
  if (!finishByUser.hit(owner).allowed) return { ok: false, code: "tooMany" };
  try {
    return await finishUpload(createUploadDeps(), { ownerId: owner, uploadId: input?.uploadId });
  } catch {
    return { ok: false, code: "unavailable" };
  }
}
