// Deletes the R2 objects of abandoned, rejected and replaced uploads. Server-side maintenance, never run automatically.
//
//   RIO_CONFIRM_CLEANUP=yes node --env-file=.env.local scripts/cleanup-uploads.ts
//
// It needs the R2 settings and SUPABASE_SECRET_KEY in the environment and the project allowed by RIO_SUPABASE_ALLOWED_REF.
// Without RIO_CONFIRM_CLEANUP=yes it only lists how many authorizations are waiting. It prints counts, never ids,
// keys, URLs or secrets, and it never touches a video that is attached to an entry.

import { createR2Store, readR2Config } from "../lib/storage/object-store.ts";
import { createAdminClient } from "../lib/supabase/admin.ts";
import { cleanupUploads } from "../lib/upload/cleanup.ts";

const cfg = readR2Config();
if (!cfg) {
  console.error("R2 is not configured; nothing to do.");
  process.exit(2);
}
const admin = createAdminClient();
const db = {
  async stale(limit: number) {
    const { data, error } = await admin.rpc("stale_video_uploads", { p_limit: limit });
    if (error) throw new Error("could not list stale uploads");
    return (data as string[]) ?? [];
  },
  async markDeleted(id: string) {
    const { error } = await admin.rpc("mark_video_upload_deleted", { p_upload: id });
    if (error) throw new Error("could not mark an upload deleted");
  },
};

if (process.env.RIO_CONFIRM_CLEANUP !== "yes") {
  console.log(`${(await db.stale(500)).length} upload authorization(s) are waiting for cleanup. Set RIO_CONFIRM_CLEANUP=yes to delete their objects.`);
} else {
  const { deleted, failed } = await cleanupUploads({ store: createR2Store(cfg), db });
  console.log(`cleaned ${deleted}, failed ${failed}`);
}
