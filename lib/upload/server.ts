import type { SupabaseClient } from "@supabase/supabase-js";
import { createR2Store, readR2Config } from "@/lib/storage/object-store";
import { createAdminClient } from "@/lib/supabase/admin";
import type { UploadStep } from "@/components/registration/next-steps";
import type { UploadDb, UploadDeps } from "./service";

// Wires the upload service to the real R2 bucket and the real database functions. Server-only.

type Env = Record<string, string | undefined>;

/** The master switch. ONLY the exact value "yes" turns uploads on; missing, empty, "YES", " yes", "true", "1" and "no" are all off. */
export function uploadsEnabled(env: Env = process.env): boolean {
  return env.RIO_UPLOADS_ENABLED === "yes";
}

/** True when the bucket settings and the secret key are present (says nothing about the switch). */
export function uploadsConfigured(env: Env = process.env): boolean {
  return readR2Config(env) !== null && Boolean(env.SUPABASE_SECRET_KEY?.trim());
}

/** Uploads may be offered and served only when the switch is on AND everything is configured. Checked by the page, by both
 *  server actions and again when the dependencies are built, so hiding the screen is never the only protection. */
export function uploadsAvailable(env: Env = process.env): boolean {
  return uploadsEnabled(env) && uploadsConfigured(env);
}

/** What the registration page shows for the upload step. Only a saved draft or uploaded entry, with registration open and
 *  uploads available, gets the working panel; everything else gets the disabled button. (The server actions enforce the same
 *  rules independently, so this decides what is shown, never what is allowed.) */
export function uploadStep(input: { open: boolean; current: { id: string; status: string } | null }, env: Env = process.env): UploadStep {
  const { open, current } = input;
  if (!open || !current || !uploadsAvailable(env)) return { kind: "off" };
  if (current.status !== "draft" && current.status !== "uploaded") return { kind: "off" };
  return { kind: "on", submissionId: current.id, hasVideo: current.status === "uploaded" };
}

type Row = { upload_id: string; expires_at: string };

export function createUploadDb(admin: SupabaseClient): UploadDb {
  const fail = (error: { message: string }): never => {
    throw new Error(error.message);
  };
  return {
    async issue(owner, submission, type, bytes) {
      const { data, error } = await admin.rpc("issue_video_upload", { p_owner: owner, p_submission: submission, p_content_type: type, p_bytes: bytes });
      if (error) fail(error);
      const row = (data as Row[] | null)?.[0];
      if (!row) throw new Error("unavailable");
      return { uploadId: row.upload_id, expiresAt: row.expires_at };
    },
    async check(owner, upload) {
      const { data, error } = await admin.rpc("check_video_upload", { p_owner: owner, p_upload: upload });
      if (error) fail(error);
      const row = (data as { declared_bytes: number | string; content_type: string }[] | null)?.[0];
      if (!row) throw new Error("unavailable");
      return { bytes: Number(row.declared_bytes), type: row.content_type };
    },
    async attach(owner, upload, bytes, type, etag) {
      const { data, error } = await admin.rpc("attach_video_upload", { p_owner: owner, p_upload: upload, p_bytes: bytes, p_content_type: type, p_etag: etag });
      if (error) fail(error);
      return { replaced: (data as string | null) ?? null };
    },
    async reject(owner, upload, status) {
      const { error } = await admin.rpc("reject_video_upload", { p_owner: owner, p_upload: upload, p_status: status });
      if (error) fail(error);
    },
  };
}

export function createUploadDeps(): UploadDeps {
  if (!uploadsEnabled()) throw new Error("Uploads are switched off."); // last line of defence: nothing is built without the switch
  const cfg = readR2Config();
  if (!cfg) throw new Error("R2 is not configured.");
  return { store: createR2Store(cfg), db: createUploadDb(createAdminClient()) };
}
