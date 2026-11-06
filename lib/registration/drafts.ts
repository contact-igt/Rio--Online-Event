import type { SupabaseClient } from "@supabase/supabase-js";
import type { OwnSubmission } from "./duplicates";

// Reads go through the signed-in parent's own session, so row level security returns that parent's rows only.
// "*" on purpose: it keeps working as additive columns arrive (for example media_consent from M3B's migration).

export type OwnRegistration = OwnSubmission & {
  child_age: number;
  parent_name: string;
  consent_version: string;
  consent_at: string;
  media_consent?: boolean;
  entry_code?: string;
  updated_at: string;
  finalized_at?: string | null;
};

/** All of the parent's own registrations, oldest first, or null if the read failed. */
export async function listOwnRegistrations(supabase: SupabaseClient): Promise<OwnRegistration[] | null> {
  const { data, error } = await supabase.from("submissions").select("*").order("created_at", { ascending: true });
  return error ? null : (data as OwnRegistration[]);
}

export const MAX_REGISTRATIONS_PER_PARENT = 10;
