"use server";

import { z } from "zod";
import { createLimiter } from "@/lib/auth/rate-limit";
import { getEvent } from "@/lib/events";
import { confirmWinner, createWinnerDb, removeWinner, type WinnerResult } from "@/lib/judging/winners";
import { staffSession } from "@/lib/staff/auth";

// Administrator actions. The administrator is identified from their own verified session; every write then runs with that same
// session, so row level security and the database triggers decide what is allowed and write the audit rows. Nothing here
// publishes results, opens registration, or uses the service role.

const byAdmin = createLimiter(120, 10 * 60_000);

export type AssignResult = { ok: true; added: number } | { ok: false; code: "invalid" | "notAllowed" | "judgeNotFound" | "tooMany" | "unavailable" };

export async function assignJudge(input: { slug: string; judgeId: string }): Promise<AssignResult> {
  const session = await staffSession("admin");
  if (!session) return { ok: false, code: "notAllowed" };
  if (!byAdmin.hit(session.user.id).allowed) return { ok: false, code: "tooMany" };
  const event = typeof input?.slug === "string" ? getEvent(input.slug) : undefined;
  const judge = z.uuid().safeParse(input?.judgeId);
  if (!event || !judge.success) return { ok: false, code: "invalid" };
  try {
    const { data, error } = await session.supabase.rpc("assign_judge_to_event", { p_judge: judge.data, p_event: event.number });
    if (error) {
      if (error.message.includes("judge_not_found")) return { ok: false, code: "judgeNotFound" };
      if (error.message.includes("forbidden") || error.code === "42501") return { ok: false, code: "notAllowed" };
      return { ok: false, code: "unavailable" };
    }
    return { ok: true, added: Number(data) || 0 };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

export async function confirmWinnerAction(input: { slug: string; submissionId: string; rank: string; displayName: string; awardLabel?: string; acknowledgeTie?: boolean }): Promise<WinnerResult> {
  const session = await staffSession("admin");
  if (!session) return { ok: false, code: "notAllowed" };
  if (!byAdmin.hit(session.user.id).allowed) return { ok: false, code: "unavailable" };
  const event = typeof input?.slug === "string" ? getEvent(input.slug) : undefined;
  if (!event) return { ok: false, code: "invalid" };
  try {
    return await confirmWinner(createWinnerDb(session.supabase), event.number, input);
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

export async function removeWinnerAction(input: { winnerId: string }): Promise<WinnerResult> {
  const session = await staffSession("admin");
  if (!session) return { ok: false, code: "notAllowed" };
  try {
    return await removeWinner(createWinnerDb(session.supabase), input?.winnerId);
  } catch {
    return { ok: false, code: "unavailable" };
  }
}
