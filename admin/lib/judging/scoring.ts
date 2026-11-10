import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { parseMarks } from "./ranking";

// A judge saving their own mark for one entry. Runs with the judge's OWN session, so row level security is the authority:
// it allows a write only for an entry assigned to this judge that is finalized, only for the judge's own row, and (through the
// scores trigger) never again once the score is final. This code adds input validation and clear answers; it grants nothing.

export type ScoreCode = "invalid" | "marksRequired" | "locked" | "notAllowed" | "conflict" | "tooMany" | "unavailable";
export type ScoreResult = { ok: true; status: "draft" | "final" } | { ok: false; code: ScoreCode };

export type ScoreDb = {
  find(entryId: string): Promise<{ id: string; status: "draft" | "final" } | null>;
  insert(row: { submissionId: string; marks: number | null; comments: string | null; status: "draft" | "final" }): Promise<void>;
  /** Returns how many rows were changed (0 when row level security or the lock refused it). */
  update(id: string, row: { marks: number | null; comments: string | null; status: "draft" | "final" }): Promise<number>;
};

const input = z.object({
  entryId: z.uuid(),
  comments: z.string().max(2000).optional(),
  final: z.boolean(),
});

export async function saveScore(db: ScoreDb, raw: { entryId: unknown; marks: unknown; comments: unknown; final: unknown }): Promise<ScoreResult> {
  const parsed = input.safeParse({ entryId: raw?.entryId, comments: typeof raw?.comments === "string" ? raw.comments : undefined, final: raw?.final });
  if (!parsed.success) return { ok: false, code: "invalid" };
  const blank = raw.marks === "" || raw.marks === null || raw.marks === undefined;
  const marks = blank ? null : parseMarks(raw.marks);
  if (!blank && marks === null) return { ok: false, code: "invalid" };
  if (parsed.data.final && marks === null) return { ok: false, code: "marksRequired" };
  const comments = parsed.data.comments?.trim() ? parsed.data.comments.trim() : null;
  const status = parsed.data.final ? "final" : "draft";

  try {
    const existing = await db.find(parsed.data.entryId);
    if (existing?.status === "final") return { ok: false, code: "locked" }; // only an administrator can reopen a final score
    if (existing) {
      const changed = await db.update(existing.id, { marks, comments, status });
      return changed === 1 ? { ok: true, status } : { ok: false, code: "notAllowed" };
    }
    await db.insert({ submissionId: parsed.data.entryId, marks, comments, status });
    return { ok: true, status };
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === "42501") return { ok: false, code: "notAllowed" }; // not assigned to this judge, not finalized, or not a judge
    if (err.code === "23505") return { ok: false, code: "conflict" }; // two saves raced: the one-score-per-judge rule held
    return { ok: false, code: "unavailable" };
  }
}

export function createScoreDb(supabase: SupabaseClient): ScoreDb {
  const fail = (error: { code?: string; message: string }) => Object.assign(new Error("database"), { code: error.code });
  return {
    async find(entryId) {
      const { data, error } = await supabase.from("scores").select("id, status").eq("submission_id", entryId).maybeSingle();
      if (error) throw fail(error);
      return data ? { id: data.id as string, status: data.status as "draft" | "final" } : null;
    },
    async insert(row) {
      const { error } = await supabase.from("scores").insert({ submission_id: row.submissionId, marks: row.marks, comments: row.comments, status: row.status });
      if (error) throw fail(error);
    },
    async update(id, row) {
      const { data, error } = await supabase.from("scores").update({ marks: row.marks, comments: row.comments, status: row.status }).eq("id", id).select("id");
      if (error) throw fail(error);
      return data?.length ?? 0;
    },
  };
}
