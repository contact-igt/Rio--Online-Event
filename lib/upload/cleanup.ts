import { pendingKey, videoKey, type ObjectStore } from "../storage/object-store.ts";

// Abandoned-object cleanup. An upload that was never confirmed, was rejected, or was replaced leaves an object behind in
// pending/ or videos/. The database lists those authorizations (stale_video_uploads); this deletes both possible
// objects for each (deleting a missing key is not an error) and then marks the authorization deleted. Nothing here
// touches a video that is attached to an entry. Run by scripts/cleanup-uploads.ts, with approval. A lifecycle rule on
// the pending/ prefix (see PROJECT_BRIEF.md) is the second line of defence.

export type CleanupDb = {
  stale(limit: number): Promise<string[]>;
  markDeleted(id: string): Promise<void>;
};

export async function cleanupUploads(deps: { store: ObjectStore; db: CleanupDb }, limit = 100): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (const id of await deps.db.stale(limit)) {
    try {
      await deps.store.remove(pendingKey(id));
      await deps.store.remove(videoKey(id));
      await deps.db.markDeleted(id);
      deleted += 1;
    } catch {
      failed += 1; // left in place; the next run tries again
    }
  }
  return { deleted, failed };
}
