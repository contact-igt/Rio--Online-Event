import type { SupabaseClient } from "@supabase/supabase-js";

// What the administrator's Judges screen shows, computed from rows read with the ADMINISTRATOR'S OWN session (row level security lets only
// an administrator read other judges' profiles, assignments and scores). The only thing that needs more is a judge's e-mail address and
// last sign-in, which live in Supabase Auth: those come in through `lookup`, which the caller builds from the secret key after checking the
// role. No password, token or hash is ever read here.

export type JudgeStatus = "invited" | "active" | "inactive";
export type AuthInfo = { email: string | null; lastSignInAt: string | null };
export type AuthLookup = (ids: string[]) => Promise<Map<string, AuthInfo> | null>;

export type JudgeRow = {
  id: string;
  name: string;
  email: string | null;
  status: JudgeStatus;
  assigned: number;
  drafts: number;
  final: number;
  /** Percent of assigned entries scored as final; null when nothing is assigned. */
  progress: number | null;
};

/** inactive: switched off by an administrator. invited: active but has never signed in yet. active: active and has signed in. */
export function judgeStatus(p: { active: boolean; lastSignInAt: string | null | undefined }): JudgeStatus {
  if (!p.active) return "inactive";
  return p.lastSignInAt ? "active" : "invited";
}

export async function loadJudges(supabase: SupabaseClient, lookup: AuthLookup | null): Promise<{ rows: JudgeRow[]; emailsKnown: boolean } | null> {
  const [profiles, assignments, scores] = await Promise.all([
    supabase.from("judge_profiles").select("user_id, display_name, active").order("display_name").limit(500),
    supabase.from("judge_assignments").select("judge_id").limit(20000),
    supabase.from("scores").select("judge_id, status").limit(20000),
  ]);
  if (profiles.error || assignments.error || scores.error) return null;
  const list = (profiles.data ?? []) as { user_id: string; display_name: string; active: boolean }[];

  let info: Map<string, AuthInfo> | null = null;
  try {
    info = lookup && list.length > 0 ? await lookup(list.map((p) => p.user_id)) : null;
  } catch {
    info = null; // the screen still works without e-mail addresses
  }

  const rows = list.map((p): JudgeRow => {
    const assigned = (assignments.data ?? []).filter((a) => a.judge_id === p.user_id).length;
    const mine = (scores.data ?? []).filter((s) => s.judge_id === p.user_id);
    const final = mine.filter((s) => s.status === "final").length;
    const auth = info?.get(p.user_id);
    return {
      id: p.user_id,
      name: p.display_name,
      email: auth?.email ?? null,
      // without Auth data a judge cannot be told apart as invited or active, so an active profile is shown as active
      status: judgeStatus({ active: p.active, lastSignInAt: info ? (auth?.lastSignInAt ?? null) : "unknown" }),
      assigned,
      drafts: mine.length - final,
      final,
      progress: assigned ? Math.round((final / assigned) * 100) : null,
    };
  });
  return { rows, emailsKnown: info !== null };
}
