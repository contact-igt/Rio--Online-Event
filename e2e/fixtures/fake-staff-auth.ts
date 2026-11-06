import { fakeSupabase } from "./fake-supabase";

// Stands in for lib/staff/auth.ts: always "signed in", reading tables from window.__staffData.
export async function requireStaff() {
  return { supabase: fakeSupabase(window.__staffData ?? {}) };
}
