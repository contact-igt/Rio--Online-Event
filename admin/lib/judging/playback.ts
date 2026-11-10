import { z } from "zod";
import { videoKey, type ReadStore } from "@/lib/storage/object-store";

// Private video playback for a judge. The database decides whether this judge may see this entry (and logs it) BEFORE any URL
// is signed; the URL lives five minutes and is returned only to the judge's own browser. The browser never sends an object key:
// it names an entry, and the opaque video id comes from the database. No result contains the key, and nothing here logs.

export const PLAYBACK_TTL_SECONDS = 300;

export type PlaybackDeps = {
  /** public.authorize_playback via the service role: returns the opaque video id or throws 'not_found'. */
  authorize(judgeId: string, submissionId: string): Promise<string>;
  store: Pick<ReadStore, "presignGet">;
};
export type PlaybackCode = "invalid" | "notFound" | "tooMany" | "unavailable";
export type Playback = { ok: true; url: string; expiresInSeconds: number } | { ok: false; code: PlaybackCode };

export async function mintPlayback(deps: PlaybackDeps, input: { judgeId: string; entryId: unknown }): Promise<Playback> {
  const entry = z.uuid().safeParse(input.entryId);
  if (!entry.success) return { ok: false, code: "invalid" };
  let videoId: string;
  try {
    videoId = await deps.authorize(input.judgeId, entry.data);
  } catch (e) {
    return { ok: false, code: (e as Error)?.message?.includes("not_found") ? "notFound" : "unavailable" };
  }
  try {
    const url = await deps.store.presignGet(videoKey(videoId), { expiresInSeconds: PLAYBACK_TTL_SECONDS });
    return { ok: true, url, expiresInSeconds: PLAYBACK_TTL_SECONDS };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}
