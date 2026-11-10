"use server";

import type { WinnerResult } from "@/lib/judging/winners";

// Judge assignment and winner confirmation need data endpoints that the Express API does not have yet (the Supabase versions were removed with the
// Supabase sign-in). Until they exist these answer "unavailable" and change nothing; no page links to them any more.

export type AssignResult = { ok: true; added: number } | { ok: false; code: "invalid" | "notAllowed" | "judgeNotFound" | "tooMany" | "unavailable" };

export async function assignJudge(_input: { slug: string; judgeId: string }): Promise<AssignResult> {
  return { ok: false, code: "unavailable" };
}

export async function confirmWinnerAction(_input: { slug: string; submissionId: string; rank: string; displayName: string; awardLabel?: string; acknowledgeTie?: boolean }): Promise<WinnerResult> {
  return { ok: false, code: "unavailable" };
}

export async function removeWinnerAction(_input: { winnerId: string }): Promise<WinnerResult> {
  return { ok: false, code: "unavailable" };
}
