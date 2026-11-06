import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { rankEntries, type Assignment, type Score } from "./ranking";

// An administrator confirming (or removing) a winner. Nothing is published by this: winners stay private until an administrator
// schedules publication (event_settings.results_publish_at, not before 14 November 2026) and that time has passed. Runs with the
// administrator's OWN session, so row level security and the winners trigger (finalized entry, matching competition) still apply.
// The display name is typed by the administrator; it is never copied from the registration.

export type WinnerCode = "invalid" | "notFound" | "incomplete" | "tieNeedsDecision" | "rankTaken" | "alreadyWinner" | "notAllowed" | "unavailable";
export type WinnerResult = { ok: true } | { ok: false; code: WinnerCode };

export type EventScoring = { finalizedIds: string[]; assignments: Assignment[]; scores: Score[] };
export type WinnerDb = {
  /** Finalized entries of the competition with the assignments and scores that decide their ranking. */
  eventScoring(eventId: number): Promise<EventScoring>;
  insert(row: { eventId: number; submissionId: string; rank: number; awardLabel: string | null; displayName: string }): Promise<void>;
  remove(winnerId: string): Promise<number>;
};

const confirmInput = z.object({
  submissionId: z.uuid(),
  rank: z.coerce.number().int().min(1).max(10),
  displayName: z.string().trim().min(1).max(60),
  awardLabel: z.string().trim().max(80).optional(),
  acknowledgeTie: z.boolean().optional(),
});

export async function confirmWinner(db: WinnerDb, eventId: number, raw: unknown): Promise<WinnerResult> {
  const parsed = confirmInput.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "invalid" };
  const { submissionId, rank, displayName, awardLabel, acknowledgeTie } = parsed.data;
  try {
    const data = await db.eventScoring(eventId);
    if (!data.finalizedIds.includes(submissionId)) return { ok: false, code: "notFound" };
    const mine = rankEntries(data.finalizedIds, data.assignments, data.scores).find((r) => r.submissionId === submissionId)!;
    if (!mine.complete) return { ok: false, code: "incomplete" }; // every assigned judge must have a final mark
    if (mine.tie && !acknowledgeTie) return { ok: false, code: "tieNeedsDecision" }; // no tie rule is approved: a human decides
    await db.insert({ eventId, submissionId, rank, awardLabel: awardLabel ? awardLabel : null, displayName });
    return { ok: true };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "23505") return { ok: false, code: err.message?.includes("submission_id") ? "alreadyWinner" : "rankTaken" };
    if (err.code === "42501") return { ok: false, code: "notAllowed" };
    return { ok: false, code: "unavailable" };
  }
}

export async function removeWinner(db: WinnerDb, winnerId: unknown): Promise<WinnerResult> {
  const id = z.uuid().safeParse(winnerId);
  if (!id.success) return { ok: false, code: "invalid" };
  try {
    return (await db.remove(id.data)) === 1 ? { ok: true } : { ok: false, code: "notFound" };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

export function createWinnerDb(supabase: SupabaseClient): WinnerDb {
  const fail = (error: { code?: string; message: string }) => Object.assign(new Error(error.message), { code: error.code });
  return {
    async eventScoring(eventId) {
      const subs = await supabase.from("submissions").select("id").eq("event_id", eventId).eq("status", "finalized");
      if (subs.error) throw fail(subs.error);
      const ids = (subs.data ?? []).map((r) => r.id as string);
      if (!ids.length) return { finalizedIds: [], assignments: [], scores: [] };
      const [a, s] = await Promise.all([
        supabase.from("judge_assignments").select("judge_id, submission_id").in("submission_id", ids),
        supabase.from("scores").select("judge_id, submission_id, marks, status").in("submission_id", ids),
      ]);
      if (a.error) throw fail(a.error);
      if (s.error) throw fail(s.error);
      return {
        finalizedIds: ids,
        assignments: (a.data ?? []).map((r) => ({ judgeId: r.judge_id as string, submissionId: r.submission_id as string })),
        scores: (s.data ?? []).map((r) => ({ judgeId: r.judge_id as string, submissionId: r.submission_id as string, marks: r.marks === null ? null : Number(r.marks), status: r.status as "draft" | "final" })),
      };
    },
    async insert(row) {
      const { error } = await supabase.from("winners").insert({ event_id: row.eventId, submission_id: row.submissionId, rank: row.rank, award_label: row.awardLabel, display_name: row.displayName });
      if (error) throw fail(error);
    },
    async remove(winnerId) {
      const { data, error } = await supabase.from("winners").delete().eq("id", winnerId).select("id");
      if (error) throw fail(error);
      return data?.length ?? 0;
    },
  };
}
