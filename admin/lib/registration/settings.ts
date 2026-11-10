import type { SupabaseClient } from "@supabase/supabase-js";
import { getConsentCopy } from "./consent";

// Registration is closed until an administrator sets the window and the consent version in event_settings.
// The database enforces this too (the submissions_guard trigger rejects inserts), so this check only decides
// what the page shows. Nothing in the app can open registration.

export type RegistrationSettings = {
  opensAt: string | null;
  closesAt: string | null;
  consentVersion: string | null;
};

export function isRegistrationOpen(settings: RegistrationSettings | null, now: Date = new Date()): boolean {
  if (!settings || !settings.opensAt || !settings.closesAt || !settings.consentVersion) return false;
  if (!getConsentCopy(settings.consentVersion)) return false; // unknown wording: stay closed
  const t = now.getTime();
  return t >= new Date(settings.opensAt).getTime() && t < new Date(settings.closesAt).getTime();
}

export async function loadSettings(supabase: SupabaseClient): Promise<RegistrationSettings | null> {
  const { data, error } = await supabase
    .from("event_settings")
    .select("submissions_open_at, submissions_close_at, current_consent_version")
    .maybeSingle();
  if (error || !data) return null;
  return { opensAt: data.submissions_open_at, closesAt: data.submissions_close_at, consentVersion: data.current_consent_version };
}
