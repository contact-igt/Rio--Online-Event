import { createClient } from "@supabase/supabase-js";
import { getSupabaseConfig } from "@/lib/supabase/config";
import { isRegistrationOpen } from "./settings";

// Whether registration is open RIGHT NOW, for the public pages (landing and competition pages) only, so that they do not send campaign
// visitors to a registration screen that says "closed". It reads the three public settings with the anonymous key and no session, and the
// pages that use it are cached for a minute, so they stay fast. It decides what a page SHOWS; the registration page and the database
// still decide what is ALLOWED. Anything unreadable counts as closed (the safe answer), and nothing here can open registration.

export type PublicRegistration = "open" | "closed";

export async function loadPublicRegistration(now: Date = new Date()): Promise<PublicRegistration> {
  try {
    const { url, publishableKey } = getSupabaseConfig();
    const client = createClient(url, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => fetch(input, { ...init, next: { revalidate: 60 } } as RequestInit) },
    });
    const { data, error } = await client.from("event_settings").select("submissions_open_at, submissions_close_at, current_consent_version").maybeSingle();
    if (error || !data) return "closed";
    return isRegistrationOpen({ opensAt: data.submissions_open_at, closesAt: data.submissions_close_at, consentVersion: data.current_consent_version }, now) ? "open" : "closed";
  } catch {
    return "closed";
  }
}
