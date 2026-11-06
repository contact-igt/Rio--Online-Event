import type { SupabaseClient, User } from "@supabase/supabase-js";
import { notFound, redirect } from "next/navigation";
import { staffLoginPath, type StaffRole } from "./paths";
import { createClient } from "@/lib/supabase/server";

// Who is signed in as staff. The role is read from user_roles (and judge_profiles.active for judges) with the caller's OWN
// session, so row level security decides what is visible; the role is never taken from user-editable token metadata.
// This only decides what a page shows. Every query and write is checked again by the database for the same session.

export type { StaffRole };
export type StaffSession = { user: User; role: StaffRole; supabase: SupabaseClient };

export async function staffRole(supabase: SupabaseClient, userId: string): Promise<StaffRole | null> {
  const { data: row } = await supabase.from("user_roles").select("role").eq("user_id", userId).maybeSingle();
  if (row?.role === "admin") return "admin";
  if (row?.role === "judge") {
    const { data: profile } = await supabase.from("judge_profiles").select("active").eq("user_id", userId).maybeSingle();
    return profile?.active === true ? "judge" : null; // a deactivated judge is nobody
  }
  return null;
}

/** For server actions: the verified staff session of this role, or null. Never throws. */
export async function staffSession(role: StaffRole): Promise<StaffSession | null> {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser(); // verified with Supabase, not just read from the cookie
    if (!data.user) return null;
    return (await staffRole(supabase, data.user.id)) === role ? { user: data.user, role, supabase } : null;
  } catch {
    return null;
  }
}

/** For pages: not signed in goes to the staff sign-in (/staff/login); signed in without this role sees a plain 404 (the area is not advertised). */
export async function requireStaff(role: StaffRole): Promise<StaffSession> {
  let session: StaffSession | null = null;
  let signedIn = false;
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      signedIn = true;
      session = (await staffRole(supabase, data.user.id)) === role ? { user: data.user, role, supabase } : null;
    }
  } catch {
    session = null;
  }
  if (!signedIn) redirect(staffLoginPath);
  if (!session) notFound();
  return session;
}
