"use server";

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createLimiter } from "@/lib/auth/rate-limit";
import { staffLogin, signInErrorCode, type LoginCode } from "@/lib/staff/login";
import { staffRole } from "@/lib/staff/auth";
import { staffHome, staffLoginPath } from "@/lib/staff/paths";
import { createClient } from "@/lib/supabase/server";

// Staff sign-in and sign-out. The password goes from the form to Supabase Auth (signInWithPassword) and nowhere else: it is never
// logged, stored, returned, put in a URL, or echoed back into the form (only the email is). Nothing here creates an account.

export type StaffLoginState = { error?: LoginCode; email?: string } | undefined;

// In-memory limits (a first layer only: each server instance counts separately; Supabase enforces its own limits too).
const byIp = createLimiter(15, 10 * 60_000);
const byEmail = createLimiter(6, 10 * 60_000);

async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}
const emailKey = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);

export async function staffSignIn(_prev: StaffLoginState, formData: FormData): Promise<StaffLoginState> {
  const rawEmail = formData.get("email");
  const email = typeof rawEmail === "string" ? rawEmail : "";
  const password = formData.get("password");

  const key = emailKey(email);
  if (!byIp.hit(await clientIp()).allowed || !byEmail.hit(key).allowed) return { error: "tooMany", email };

  let result;
  try {
    const supabase = await createClient();
    result = await staffLogin(
      {
        async signIn(e, p) {
          const { data, error } = await supabase.auth.signInWithPassword({ email: e, password: p });
          if (error || !data.user) return { error: signInErrorCode(error) };
          return { userId: data.user.id };
        },
        roleOf: (userId) => staffRole(supabase, userId),
        async signOut() {
          await supabase.auth.signOut({ scope: "local" });
        },
      },
      { email, password },
    );
  } catch {
    return { error: "unavailable", email }; // for example Supabase is not configured for this environment
  }
  if (!result.ok) return { error: result.code, email };

  byEmail.reset(key);
  redirect(staffHome(result.role)); // outside try/catch: redirect() works by throwing
}

export async function staffSignOut(): Promise<void> {
  try {
    const supabase = await createClient();
    await supabase.auth.signOut({ scope: "local" }); // this browser only
  } catch {
    // nothing to sign out of if the project is not configured
  }
  redirect(staffLoginPath);
}
