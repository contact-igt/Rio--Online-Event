"use server";

import type { Playback } from "@/lib/judging/playback";
import type { ScoreResult } from "@/lib/judging/scoring";

// Video playback and scoring need Express endpoints that do not exist yet. Until then these answer "unavailable" and change nothing.

export async function getPlaybackUrl(_input: { entryId: string }): Promise<Playback> {
  return { ok: false, code: "unavailable" };
}

export async function saveMyScore(_input: { entryId: string; marks: string; comments: string; final: boolean }): Promise<ScoreResult> {
  return { ok: false, code: "unavailable" };
}
