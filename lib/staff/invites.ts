import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { emailSchema } from "@/lib/auth/schemas";
import { createAdminClient, secretKeyStatus } from "@/lib/supabase/admin";
import type { AuthInfo, AuthLookup } from "./judges";

// Inviting a judge. This file is the ONLY place that builds the secret-key client for staff management, and it is reached only from the
// server actions in app/admin/judges, after they have verified the administrator's own session. The secret key never reaches a browser.
//
// How it works:
//   1. Supabase Auth sends the invitation e-mail itself (inviteUserByEmail), using the project's own SMTP. The e-mail carries a one-time link
//      to /staff/set-password, where the judge chooses a password. The app never sees, stores or shows a password, and sends no password.
//   2. Right after the invitation, the role and the judge profile are recorded with the ADMINISTRATOR'S OWN session, so row level security
//      and the audit triggers apply as for any other administrator action.
//   3. If step 2 fails, the invitation is undone where that is safe (the auth user was created seconds ago, never signed in); otherwise the
//      screen says exactly what is left over. An account with no role cannot do anything: a staff area needs the role.
//   4. An e-mail that already has an account is NEVER turned into a judge here: that needs a reviewed policy (a parent's account holds
//      children's data). It is refused with a plain message.
//
// Off by default: nothing is invited until RIO_STAFF_INVITES_ENABLED is exactly "yes" (set only after Supabase's SMTP is configured and a
// test e-mail has been received) and the secret key is present. Until then the screen says so and no Supabase Auth call is made.

type Env = Record<string, string | undefined>;

export const staffInvitesEnabled = (env: Env = process.env) => env.RIO_STAFF_INVITES_ENABLED === "yes";

export type InviteReadiness = { enabled: boolean; secretKey: "ok" | "missing" | "badFormat"; ready: boolean };
export function inviteReadiness(env: Env = process.env): InviteReadiness {
  const enabled = staffInvitesEnabled(env);
  const secretKey = secretKeyStatus(env);
  return { enabled, secretKey, ready: enabled && secretKey === "ok" };
}

export const inviteSchema = z.object({
  email: emailSchema,
  displayName: z
    .string()
    .max(200)
    .transform((s) => s.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1).max(80)),
});

export type InviteCode = "invalid" | "notAllowed" | "disabled" | "notConfigured" | "tooMany" | "duplicate" | "alreadyJudge" | "inviteFailed" | "provisionFailed" | "partial";
export type InviteResult = { ok: true } | { ok: false; code: InviteCode };

export type InvitedUser = { userId: string; createdAt: string; lastSignInAt: string | null };
export type InviteDeps = {
  /** E-mail addresses of the judges that already exist (from Supabase Auth). */
  judgeEmails(): Promise<string[]>;
  invite(email: string): Promise<{ user: InvitedUser } | { error: "exists" | "rateLimited" | "failed" }>;
  /** Records the role and profile with the administrator's own session. False if anything was refused. */
  provision(userId: string, displayName: string): Promise<boolean>;
  /** Deletes the auth user (secret key). */
  remove(userId: string): Promise<boolean>;
  now?: () => number;
};

const FRESH_MS = 120_000;

/** The whole invitation, with its dependencies passed in so every branch can be tested without Supabase. */
export async function inviteJudgeFlow(deps: InviteDeps, raw: { email: unknown; displayName: unknown }): Promise<InviteResult> {
  const parsed = inviteSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "invalid" };
  const { email, displayName } = parsed.data;

  let known: string[];
  try {
    known = await deps.judgeEmails();
  } catch {
    return { ok: false, code: "inviteFailed" };
  }
  if (known.some((e) => e.toLowerCase() === email)) return { ok: false, code: "alreadyJudge" };

  const sent = await deps.invite(email).catch(() => ({ error: "failed" as const }));
  if ("error" in sent) return { ok: false, code: sent.error === "exists" ? "duplicate" : sent.error === "rateLimited" ? "tooMany" : "inviteFailed" };

  if (await deps.provision(sent.user.userId, displayName).catch(() => false)) return { ok: true };

  // The role was not recorded. Undo the invitation only if this call created the user (seconds ago, never signed in).
  const age = (deps.now?.() ?? Date.now()) - Date.parse(sent.user.createdAt);
  const created = Number.isFinite(age) && age >= 0 && age <= FRESH_MS && sent.user.lastSignInAt === null;
  if (created && (await deps.remove(sent.user.userId).catch(() => false))) return { ok: false, code: "provisionFailed" };
  return { ok: false, code: "partial" };
}

type UserRow = { id: string; email?: string | null; created_at: string; last_sign_in_at?: string | null };

/** Dependencies backed by Supabase. `session` is the verified administrator's own client; the secret-key client is built here, not passed around. */
export function createInviteDeps(session: SupabaseClient): InviteDeps {
  const admin = createAdminClient();
  return {
    async judgeEmails() {
      const { data, error } = await session.from("judge_profiles").select("user_id").limit(500);
      if (error) throw new Error("judge list unavailable");
      const out: string[] = [];
      for (const p of data ?? []) {
        const { data: u } = await admin.auth.admin.getUserById(p.user_id as string);
        if (u.user?.email) out.push(u.user.email);
      }
      return out;
    },
    async invite(email) {
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email);
      if (error || !data.user) {
        if (error?.status === 429 || error?.code === "over_email_send_rate_limit") return { error: "rateLimited" };
        if (error?.code === "email_exists" || error?.code === "user_already_exists" || /already (been )?registered/i.test(error?.message ?? "")) return { error: "exists" };
        return { error: "failed" };
      }
      const u = data.user as unknown as UserRow;
      return { user: { userId: u.id, createdAt: u.created_at, lastSignInAt: u.last_sign_in_at ?? null } };
    },
    async provision(userId, displayName) {
      const role = await session.from("user_roles").insert({ user_id: userId, role: "judge" });
      if (role.error) return false;
      const profile = await session.from("judge_profiles").insert({ user_id: userId, display_name: displayName, active: true });
      if (profile.error) {
        await session.from("user_roles").delete().eq("user_id", userId); // do not leave a role without a profile
        return false;
      }
      return true;
    },
    async remove(userId) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      return !error;
    },
  };
}

/** Looks up judges' e-mail addresses and last sign-in (secret key). Used only to label the Judges screen. */
export function createAuthLookup(): AuthLookup {
  const admin = createAdminClient();
  return async (ids) => {
    const out = new Map<string, AuthInfo>();
    for (const id of ids.slice(0, 200)) {
      const { data } = await admin.auth.admin.getUserById(id);
      const u = data.user as unknown as UserRow | null;
      out.set(id, { email: u?.email ?? null, lastSignInAt: u?.last_sign_in_at ?? null });
    }
    return out;
  };
}
