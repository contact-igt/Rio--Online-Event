import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { events } from "@/lib/events";
import { getSupabaseConfig } from "@/lib/supabase/config";

// The public winners page reads ONLY the `published_winners` view with the anonymous (publishable) key and no session. The database
// is the authority: that view returns rows only when an administrator has set a publication time that has passed (and the time cannot
// be earlier than 14 November 2026). This code never decides to publish, never writes, and never shows a row the view did not return.

export type Winner = { eventId: number; rank: number; displayName: string; awardLabel: string | null };
export type ResultsState = { kind: "unavailable" } | { kind: "pending" } | { kind: "published"; winners: Winner[] };

const row = z.object({
  event_id: z.number().int(),
  rank: z.number().int().min(1).max(10),
  display_name: z.string().trim().min(1).max(60),
  award_label: z.string().trim().max(80).nullable(),
});

/** Keeps only well-formed rows for known competitions, in competition order then rank. Anything else is dropped, not shown. */
export function toWinners(raw: unknown): Winner[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set(events.map((e) => e.number));
  const out: Winner[] = [];
  for (const item of raw) {
    const parsed = row.safeParse(item);
    if (parsed.success && known.has(parsed.data.event_id)) {
      out.push({ eventId: parsed.data.event_id, rank: parsed.data.rank, displayName: parsed.data.display_name, awardLabel: parsed.data.award_label || null });
    }
  }
  return out.sort((a, b) => a.eventId - b.eventId || a.rank - b.rank);
}

export type ResultsReader = {
  winners(): Promise<{ data: unknown; error: unknown }>;
  publishAt(): Promise<{ data: string | null; error: unknown }>;
};

/**
 * pending: nothing may be shown (not scheduled, scheduled for later, or the settings could not be read: silence is the safe answer);
 * published: the view returned rows, or the publication time has passed and there are simply no confirmed winners;
 * unavailable: the view itself could not be read.
 */
export async function loadResults(reader: ResultsReader, now: Date = new Date()): Promise<ResultsState> {
  let won: { data: unknown; error: unknown };
  try {
    won = await reader.winners();
  } catch {
    return { kind: "unavailable" };
  }
  if (won.error) return { kind: "unavailable" };
  const winners = toWinners(won.data);
  if (winners.length > 0) return { kind: "published", winners };
  try {
    const at = await reader.publishAt();
    if (!at.error && at.data && new Date(at.data).getTime() <= now.getTime()) return { kind: "published", winners: [] };
  } catch {
    // the settings could not be read: stay silent
  }
  return { kind: "pending" };
}

/** The real reader: anonymous key, no session, no caching of any response. */
export function createPublicReader(): ResultsReader {
  const { url, publishableKey } = getSupabaseConfig();
  const client = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  });
  return {
    winners: async () => client.from("published_winners").select("event_id, rank, award_label, display_name"),
    publishAt: async () => {
      const res = await client.from("event_settings").select("results_publish_at").maybeSingle();
      return { data: (res.data?.results_publish_at as string | null | undefined) ?? null, error: res.error };
    },
  };
}
