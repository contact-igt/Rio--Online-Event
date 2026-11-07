"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createLimiter } from "@/lib/auth/rate-limit";
import { mustChangePassword, staffRole } from "@/lib/staff/auth";
import { staffHome } from "@/lib/staff/paths";
import { setStaffPassword, type SetPasswordCode } from "@/lib/staff/password-setup";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Sets a staff member's password from the invitation link (or, in session mode, for the staff member already signed in). Nothing here
// creates an account or grants a role: the role was recorded by an administrator, and it is re-read here from user_roles.

export type SetPasswordState = { error?: SetPasswordCode; session?: boolean } | undefined;

const byIp = createLimiter(15, 10 * 60_000);

export async function setPasswordAction(_prev: SetPasswordState, formData: FormData): Promise<SetPasswordState> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
  if (!byIp.hit(ip).allowed) return { error: "tooMany" };

  let result;
  try {
    const supabase = await createClient();
    result = await setStaffPassword(
      {
        async verify(tokenHash, type) {
          const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
          if (error || !data.user) return { error: error && error.status && error.status >= 500 ? "unavailable" : "link" };
          return { userId: data.user.id };
        },
        async currentUser() {
          const { data } = await supabase.auth.getUser();
          return data.user ? { userId: data.user.id } : null;
        },
        async setPassword(password) {
          const { data: before } = await supabase.auth.getUser();
          const { error } = await supabase.auth.updateUser({ password });
          if (error) return error.code === "weak_password" || error.code === "same_password" ? "weak" : "unavailable";
          // A password set by an administrator (new judge or reset) is now replaced by the judge's own: lift the mark. Only the secret key can write
          // app_metadata. If this fails the judge stays blocked and can simply choose another password.
          if (before.user && mustChangePassword(before.user)) {
            try {
              const cleared = await createAdminClient().auth.admin.updateUserById(before.user.id, { app_metadata: { must_change_password: false } });
              if (cleared.error) return "unavailable";
            } catch {
              return "unavailable";
            }
          }
          return "ok";
        },
        roleOf: (userId) => staffRole(supabase, userId),
        async signOut() {
          await supabase.auth.signOut({ scope: "local" });
        },
      },
      { password: formData.get("password"), confirm: formData.get("confirm"), tokenHash: formData.get("tokenHash"), type: formData.get("type") },
    );
  } catch {
    return { error: "unavailable" };
  }
  if (!result.ok) return { error: result.code, session: result.session };
  redirect(staffHome(result.role)); // outside try/catch: redirect() works by throwing
}
