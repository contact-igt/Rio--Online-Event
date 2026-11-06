"use server";

import { createLimiter } from "@/lib/auth/rate-limit";
import { mintPlayback, type Playback } from "@/lib/judging/playback";
import { createScoreDb, saveScore, type ScoreResult } from "@/lib/judging/scoring";
import { createPlaybackDeps, playbackAvailable } from "@/lib/judging/server";
import { staffSession } from "@/lib/staff/auth";

// Judge actions. The judge is identified from their own verified session and must hold the active judge role; the database
// decides which entries they may see or score. The playback switch is the first statement of the playback action. Nothing
// here logs, and no result contains an object key.

const playbackByJudge = createLimiter(40, 10 * 60_000);
const scoreByJudge = createLimiter(120, 10 * 60_000);

export async function getPlaybackUrl(input: { entryId: string }): Promise<Playback> {
  if (!playbackAvailable()) return { ok: false, code: "unavailable" }; // switched off or not configured: nothing else runs
  const session = await staffSession("judge");
  if (!session) return { ok: false, code: "notFound" };
  if (!playbackByJudge.hit(session.user.id).allowed) return { ok: false, code: "tooMany" };
  try {
    return await mintPlayback(createPlaybackDeps(), { judgeId: session.user.id, entryId: input?.entryId });
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

export async function saveMyScore(input: { entryId: string; marks: string; comments: string; final: boolean }): Promise<ScoreResult> {
  const session = await staffSession("judge");
  if (!session) return { ok: false, code: "notAllowed" };
  if (!scoreByJudge.hit(session.user.id).allowed) return { ok: false, code: "tooMany" };
  try {
    return await saveScore(createScoreDb(session.supabase), input ?? { entryId: null, marks: null, comments: null, final: null });
  } catch {
    return { ok: false, code: "unavailable" };
  }
}
