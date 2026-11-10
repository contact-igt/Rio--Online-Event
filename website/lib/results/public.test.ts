import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadResults, toWinners, type ResultsReader } from "./public";

const NOW = new Date("2026-11-14T12:00:00+05:30");
const winner = (over: Record<string, unknown> = {}) => ({ event_id: 4, rank: 1, award_label: null, display_name: "Asha", ...over });
const reader = (over: { winners?: () => Promise<{ data: unknown; error: unknown }>; publishAt?: () => Promise<{ data: string | null; error: unknown }> } = {}): ResultsReader => ({
  winners: over.winners ?? (async () => ({ data: [], error: null })),
  publishAt: over.publishAt ?? (async () => ({ data: null, error: null })),
});

describe("toWinners keeps only well-formed rows of known competitions, in order, and nothing else", () => {
  it("orders by competition then rank and passes only the four public fields", () => {
    const rows = toWinners([
      winner({ event_id: 4, rank: 2, display_name: "Bala", submission_id: "s1", child_name: "SECRET", approved_by: "u1" }),
      winner({ event_id: 2, rank: 1, display_name: "Chitra", award_label: " First prize " }),
      winner({ event_id: 4, rank: 1, display_name: "Asha" }),
    ]);
    expect(rows).toEqual([
      { eventId: 2, rank: 1, displayName: "Chitra", awardLabel: "First prize" },
      { eventId: 4, rank: 1, displayName: "Asha", awardLabel: null },
      { eventId: 4, rank: 2, displayName: "Bala", awardLabel: null },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/SECRET|s1|u1|submission|approved|child/);
  });
  it("drops malformed rows and unknown competitions instead of showing them", () => {
    expect(toWinners([winner({ event_id: 99 }), winner({ rank: 0 }), winner({ rank: 11 }), winner({ display_name: "" }), winner({ display_name: "x".repeat(61) }), winner({ award_label: "x".repeat(81) }), winner({ event_id: "4" }), null, 5, "x", {}])).toEqual([]);
    expect(toWinners(null)).toEqual([]);
    expect(toWinners({ rows: [] })).toEqual([]);
  });
});

describe("loadResults", () => {
  it("shows winners exactly when the view returns them", async () => {
    const state = await loadResults(reader({ winners: async () => ({ data: [winner()], error: null }) }), NOW);
    expect(state).toEqual({ kind: "published", winners: [{ eventId: 4, rank: 1, displayName: "Asha", awardLabel: null }] });
  });
  it("is 'pending' (nothing shown) when there are no rows and no publication time, or one in the future", async () => {
    expect(await loadResults(reader(), NOW)).toEqual({ kind: "pending" });
    expect(await loadResults(reader({ publishAt: async () => ({ data: "2026-11-20T10:00:00+05:30", error: null }) }), NOW)).toEqual({ kind: "pending" });
  });
  it("is 'published' with no winners once the time has passed and none are confirmed", async () => {
    expect(await loadResults(reader({ publishAt: async () => ({ data: "2026-11-14T09:00:00+05:30", error: null }) }), NOW)).toEqual({ kind: "published", winners: [] });
  });
  it("never trusts the clock to show rows: a past time without rows from the view shows no winners", async () => {
    const state = await loadResults(reader({ publishAt: async () => ({ data: "2026-11-14T09:00:00+05:30", error: null }) }), NOW);
    expect(state.kind === "published" && state.winners.length).toBe(0);
  });
  it("an unreadable view is 'unavailable'; an unreadable setting stays silent (pending)", async () => {
    expect(await loadResults(reader({ winners: async () => ({ data: null, error: { message: "x" } }) }), NOW)).toEqual({ kind: "unavailable" });
    expect(await loadResults(reader({ winners: async () => { throw new Error("network"); } }), NOW)).toEqual({ kind: "unavailable" });
    expect(await loadResults(reader({ publishAt: async () => ({ data: "2026-11-14T09:00:00+05:30", error: { message: "x" } }) }), NOW)).toEqual({ kind: "pending" });
    expect(await loadResults(reader({ publishAt: async () => { throw new Error("network"); } }), NOW)).toEqual({ kind: "pending" });
  });
  it("garbage dates are not a publication time", async () => {
    expect(await loadResults(reader({ publishAt: async () => ({ data: "not a date", error: null }) }), NOW)).toEqual({ kind: "pending" });
  });
});

describe("the public reader's source", () => {
  const source = readFileSync(new URL("./public.ts", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  it("reads only the published view and the publication time, with the publishable key, never writes, and disables caching", () => {
    expect(source).toContain('from("published_winners").select("event_id, rank, award_label, display_name")');
    expect(source).toContain('from("event_settings").select("results_publish_at")');
    expect(source).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(|SUPABASE_SECRET_KEY|createAdminClient|from\("(winners|submissions|scores)"\)/);
    expect(source).toContain('cache: "no-store"');
    expect(source).toContain("persistSession: false");
  });
});
