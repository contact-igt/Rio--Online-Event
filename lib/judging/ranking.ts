// Totals and rankings for one competition. Pure functions: the same scores always give the same order.
//
// APPROVED RULES (PROJECT_BRIEF.md FR8, §4 M6): marks are one 0 to 100 mark with two decimals per judge per entry; the ranking is
// reproducible; ties are FLAGGED and never resolved automatically; an administrator confirms winners by hand.
// NOT APPROVED (decision D8 is still open): a per-criterion rubric, weights, a judges-per-entry requirement, and any tie-break
// rule. So this module averages the final marks, ranks only entries that every assigned judge has finalized, and marks any entries
// with an equal average as a tie for the administrator to decide.

export type Assignment = { submissionId: string; judgeId: string };
export type Score = { submissionId: string; judgeId: string; marks: number | null; status: "draft" | "final" };

export type Ranked = {
  submissionId: string;
  assigned: number;
  finalScores: number;
  drafts: number;
  /** Every assigned judge has a final mark (and at least one judge is assigned). Only complete entries are ranked. */
  complete: boolean;
  /** Mean of the final marks, two decimals, or null when no final mark exists. */
  average: number | null;
  /** Standard competition ranking (1, 2, 2, 4) among complete entries; null when incomplete. */
  rank: number | null;
  /** Another complete entry has exactly the same average: the administrator must decide. */
  tie: boolean;
};

const cents = (marks: number) => Math.round(marks * 100);

export function rankEntries(submissionIds: readonly string[], assignments: readonly Assignment[], scores: readonly Score[]): Ranked[] {
  const rows = submissionIds.map((submissionId) => {
    const judges = new Set(assignments.filter((a) => a.submissionId === submissionId).map((a) => a.judgeId));
    // Only a score by an ASSIGNED judge counts; a stray row from anyone else is ignored.
    const mine = scores.filter((s) => s.submissionId === submissionId && judges.has(s.judgeId));
    const final = mine.filter((s) => s.status === "final" && s.marks !== null);
    const sum = final.reduce((n, s) => n + cents(s.marks!), 0);
    const avg100 = final.length ? Math.round(sum / final.length) : null;
    return {
      submissionId,
      assigned: judges.size,
      finalScores: final.length,
      drafts: mine.filter((s) => s.status === "draft").length,
      complete: judges.size > 0 && final.length === judges.size,
      avg100,
    };
  });
  const complete = rows.filter((r) => r.complete);
  return rows
    .map((r) => ({
      submissionId: r.submissionId,
      assigned: r.assigned,
      finalScores: r.finalScores,
      drafts: r.drafts,
      complete: r.complete,
      average: r.avg100 === null ? null : r.avg100 / 100,
      rank: r.complete ? 1 + complete.filter((o) => o.avg100! > r.avg100!).length : null,
      tie: r.complete && complete.some((o) => o.submissionId !== r.submissionId && o.avg100 === r.avg100),
    }))
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || (b.average ?? -1) - (a.average ?? -1) || a.submissionId.localeCompare(b.submissionId));
}

/** Marks as typed by a judge: 0 to 100, at most two decimals. Returns null for anything else. */
export function parseMarks(raw: unknown): number | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return null;
  const n = Number(text);
  return n >= 0 && n <= 100 ? n : null;
}
