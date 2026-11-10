import type { User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signInPath } from "./paths";

/**
 * The signed-in parent, or null. getUser() asks the Auth server to validate the session, so an expired,
 * revoked or forged cookie is never trusted (getSession() alone would trust the cookie).
 */
export async function getParent(): Promise<User | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
}

/** Protected pages call this first: no valid session means a redirect to sign-in, keeping the chosen event. */
export async function requireParent(event: string | null): Promise<User> {
  let user: User | null = null;
  try {
    user = await getParent();
  } catch {
    user = null; // missing/invalid configuration: the sign-in page explains it, so no loop
  }
  if (!user) redirect(signInPath(event));
  return user;
}
