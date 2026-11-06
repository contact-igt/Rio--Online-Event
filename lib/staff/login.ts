import { z } from "zod";
import { emailSchema } from "@/lib/auth/schemas";
import type { StaffRole } from "./paths";

// Staff (administrator and judge) sign-in with an email and a password. Plain functions with their dependencies passed in, so the
// rules can be tested without Supabase:
//   * the password is checked by Supabase Auth (signInWithPassword); this code never sees a hash, never stores or logs a password,
//     and never puts it in a URL, a cookie of its own, an error or a result;
//   * a correct password is NOT enough: the role is then read from user_roles (and judge_profiles.active) with the person's own
//     session. A parent, an account with no role and a deactivated judge are signed out again and refused;
//   * a wrong password, an unknown email and an account that has no password at all (every parent signs in with an e-mailed code and
//     has none) give the SAME answer, so the page cannot be used to learn which emails exist.

export type LoginCode = "invalid" | "credentials" | "notStaff" | "tooMany" | "unavailable";
export type LoginResult = { ok: true; role: StaffRole } | { ok: false; code: LoginCode };

export type LoginDeps = {
  signIn(email: string, password: string): Promise<{ userId: string } | { error: "credentials" | "tooMany" | "unavailable" }>;
  roleOf(userId: string): Promise<StaffRole | null>;
  signOut(): Promise<void>;
};

const input = z.object({ email: emailSchema, password: z.string().min(1).max(256) });

export async function staffLogin(deps: LoginDeps, raw: { email: unknown; password: unknown }): Promise<LoginResult> {
  const parsed = input.safeParse({ email: raw?.email, password: raw?.password });
  if (!parsed.success) return { ok: false, code: "invalid" }; // nothing is sent to Supabase

  let signedIn: Awaited<ReturnType<LoginDeps["signIn"]>>;
  try {
    signedIn = await deps.signIn(parsed.data.email, parsed.data.password);
  } catch {
    return { ok: false, code: "unavailable" };
  }
  if ("error" in signedIn) return { ok: false, code: signedIn.error };

  let role: StaffRole | null = null;
  try {
    role = await deps.roleOf(signedIn.userId);
  } catch {
    role = null; // if the role cannot be read, nobody gets in
  }
  if (!role) {
    await deps.signOut().catch(() => undefined); // do not leave a session behind for an account that has no staff access
    return { ok: false, code: "notStaff" };
  }
  return { ok: true, role };
}

/** Maps a Supabase Auth error from signInWithPassword to one of three answers. Never returns or logs the provider's text. */
export function signInErrorCode(error: { status?: number; code?: string } | null | undefined): "credentials" | "tooMany" | "unavailable" {
  if (!error) return "unavailable";
  if (error.status === 429 || error.code === "over_request_rate_limit" || error.code === "over_email_send_rate_limit") return "tooMany";
  // wrong password, unknown email, unconfirmed email, banned account and "no password set" are all answered the same way
  if (typeof error.status === "number" && error.status >= 400 && error.status < 500) return "credentials";
  return "unavailable";
}
