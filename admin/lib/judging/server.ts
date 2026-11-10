import type { SupabaseClient } from "@supabase/supabase-js";
import { createR2Store, readR2Config } from "@/lib/storage/object-store";
import { createAdminClient, secretKeyStatus } from "@/lib/supabase/admin";
import type { PlaybackDeps } from "./playback";

// Wires judge playback to the real bucket and database. Server-only. Playback is a SEPARATE switch from uploads and final
// submission: RIO_PLAYBACK_ENABLED, where only the exact value "yes" turns it on and anything else is OFF. With it off, no URL
// is ever signed, whatever roles and assignments exist.

type Env = Record<string, string | undefined>;

export const playbackEnabled = (env: Env = process.env) => env.RIO_PLAYBACK_ENABLED === "yes";

export function playbackConfigured(env: Env = process.env): boolean {
  return readR2Config(env) !== null && secretKeyStatus(env) === "ok";
}

export const playbackAvailable = (env: Env = process.env) => playbackEnabled(env) && playbackConfigured(env);

export function createPlaybackDb(admin: SupabaseClient): Pick<PlaybackDeps, "authorize"> {
  return {
    async authorize(judgeId, submissionId) {
      const { data, error } = await admin.rpc("authorize_playback", { p_judge: judgeId, p_submission: submissionId });
      if (error) throw new Error(error.message.includes("not_found") ? "not_found" : "database");
      if (typeof data !== "string") throw new Error("not_found");
      return data;
    },
  };
}

export function createPlaybackDeps(): PlaybackDeps {
  if (!playbackEnabled()) throw new Error("Playback is switched off."); // last line of defence: nothing is built without the switch
  const cfg = readR2Config();
  if (!cfg) throw new Error("R2 is not configured.");
  return { ...createPlaybackDb(createAdminClient()), store: createR2Store(cfg) };
}
