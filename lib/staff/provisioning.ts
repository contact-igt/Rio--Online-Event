import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { emailSchema } from "@/lib/auth/schemas";
import { createAdminClient, secretKeyStatus } from "@/lib/supabase/admin";

// Creating a judge's account by hand, without any e-mail. Reached only from the server actions in app/admin/judges, after they have verified the
// administrator's own session. This file and lib/staff/invites.ts are the only places that build the secret-key client for staff management.
//
// How it works:
//   1. A strong password is generated HERE, on the server (Web Crypto, not Math.random). It is passed to Supabase Auth (createUser) and returned
//      once to the administrator who pressed the button. It is never written to a table, a log, a URL or an error, and nothing is e-mailed.
//   2. The account is created with the "must change password" mark in app_metadata. app_metadata can be written only with the secret key, never by
//      the account's owner, so a judge cannot clear it. lib/staff/auth.ts refuses the staff area until the judge has chosen their own password.
//   3. The role and the profile are recorded with the ADMINISTRATOR'S OWN session, so row level security and the audit triggers apply as for any
//      other administrator action. The profile is inserted switched OFF and switched on as the very last step: a judge becomes usable only after
//      every earlier step has succeeded.
//   4. If any step fails, the earlier ones are undone in reverse order. If an undo fails too, the result says "partial": the account then has
//      no role or an inactive profile, so it can do nothing, and its password was never shown to anyone.
//   5. An e-mail that already has an account is never turned into a judge: Supabase refuses a duplicate, and nothing existing is touched.
//
// Off by default: nothing is created until RIO_STAFF_PROVISIONING_ENABLED is exactly "yes" (a different switch from the invitations one) and the
// secret key is present.

type Env = Record<string, string | undefined>;

export const staffProvisioningEnabled = (env: Env = process.env) => env.RIO_STAFF_PROVISIONING_ENABLED === "yes";

export type ProvisioningReadiness = { enabled: boolean; secretKey: "ok" | "missing" | "badFormat"; ready: boolean };
export function provisioningReadiness(env: Env = process.env): ProvisioningReadiness {
  const enabled = staffProvisioningEnabled(env);
  const secretKey = secretKeyStatus(env);
  return { enabled, secretKey, ready: enabled && secretKey === "ok" };
}

// ---- passwords -------------------------------------------------------------------------------------------------------------------------------

// No 0/O/1/l/I, so a password read from a screen or a note is not misread.
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGIT = "23456789";

/** A uniformly random index below n (rejection sampling, so there is no modulo bias). */
function randomBelow(n: number): number {
  const limit = Math.floor(2 ** 32 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0]! >= limit);
  return buf[0]! % n;
}
const pick = (set: string) => set[randomBelow(set.length)]!;

/** 20 random letters and digits (at least 3 of each kind) in five groups of four joined by hyphens: 24 characters, about 115 bits. */
export function generatePassword(): string {
  const chars = [pick(LOWER), pick(LOWER), pick(LOWER), pick(UPPER), pick(UPPER), pick(UPPER), pick(DIGIT), pick(DIGIT), pick(DIGIT)];
  const all = LOWER + UPPER + DIGIT;
  while (chars.length < 20) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return [0, 4, 8, 12, 16].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

const WEAK = new Set(["password", "password1", "password123", "123456789012", "qwertyuiop12", "administrator", "letmein12345", "welcome12345"]);

/** Why a password is refused (fixed labels; the password itself is never returned). */
export function passwordProblems(password: string, email: string): string[] {
  const out: string[] = [];
  if (password.length < 12) out.push("shorter than 12 characters");
  if (password.length > 128) out.push("longer than 128 characters");
  if (new Set(password).size < 5) out.push("too few different characters");
  const local = email.split("@")[0] ?? "";
  if (local.length >= 4 && password.toLowerCase().includes(local.toLowerCase())) out.push("contains the email name");
  if (WEAK.has(password.toLowerCase())) out.push("a commonly used password");
  if (/^\s|\s$/.test(password)) out.push("starts or ends with a space");
  return out;
}

// ---- adding a judge ---------------------------------------------------------------------------------------------------------------------------

export const provisionSchema = z.object({
  email: emailSchema,
  displayName: z
    .string()
    .max(200)
    .transform((s) => s.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1).max(80)),
});

export type ProvisionCode =
  | "invalid"
  | "emailNotConfirmed"
  | "notAllowed"
  | "disabled"
  | "notConfigured"
  | "tooMany"
  | "duplicate"
  | "createFailed"
  | "provisionFailed"
  | "partial";
/** On success the password is returned ONCE, to the administrator who asked. */
export type ProvisionResult = { ok: true; email: string; password: string } | { ok: false; code: ProvisionCode };

export type ProvisionDeps = {
  /** Secret key. Creates a confirmed account marked "must change password". */
  createUser(email: string, password: string): Promise<{ userId: string } | { error: "exists" | "rateLimited" | "failed" }>;
  /** The next three use the administrator's own session. True only if the database accepted the change. */
  addRole(userId: string): Promise<boolean>;
  addProfile(userId: string, displayName: string): Promise<boolean>;
  activate(userId: string): Promise<boolean>;
  removeProfile(userId: string): Promise<boolean>;
  removeRole(userId: string): Promise<boolean>;
  /** Secret key. */
  removeUser(userId: string): Promise<boolean>;
  /** Overridable so tests can fix the password; production always uses generatePassword. */
  generate?: () => string;
};

/** The whole creation, with its dependencies passed in so every branch can be tested without Supabase. */
export async function provisionJudgeFlow(deps: ProvisionDeps, raw: { email: unknown; displayName: unknown; emailVerified: unknown }): Promise<ProvisionResult> {
  const parsed = provisionSchema.safeParse({ email: raw?.email, displayName: raw?.displayName });
  if (!parsed.success) return { ok: false, code: "invalid" };
  // The administrator vouches that the address is the judge's own before it is marked confirmed (no confirmation e-mail is sent).
  if (raw.emailVerified !== true) return { ok: false, code: "emailNotConfirmed" };
  const { email, displayName } = parsed.data;

  const generate = deps.generate ?? generatePassword;
  let password = generate();
  for (let tries = 0; passwordProblems(password, email).length > 0; tries++) {
    if (tries >= 3) return { ok: false, code: "createFailed" };
    password = generate();
  }

  const created = await deps.createUser(email, password).catch(() => ({ error: "failed" as const }));
  if ("error" in created) return { ok: false, code: created.error === "exists" ? "duplicate" : created.error === "rateLimited" ? "tooMany" : "createFailed" };
  const id = created.userId;

  const safe = (step: () => Promise<boolean>) => step().catch(() => false);
  const undo = async (steps: (() => Promise<boolean>)[]): Promise<ProvisionResult> => {
    let clean = true;
    for (const step of steps) clean = (await safe(step)) && clean; // every undo is attempted, in reverse order
    return { ok: false, code: clean ? "provisionFailed" : "partial" };
  };

  if (!(await safe(() => deps.addRole(id)))) return undo([() => deps.removeUser(id)]);
  if (!(await safe(() => deps.addProfile(id, displayName)))) return undo([() => deps.removeRole(id), () => deps.removeUser(id)]);
  if (!(await safe(() => deps.activate(id)))) return undo([() => deps.removeProfile(id), () => deps.removeRole(id), () => deps.removeUser(id)]);
  return { ok: true, email, password };
}

// ---- resetting a judge's password ------------------------------------------------------------------------------------------------------------

export type ResetCode = "invalid" | "notAllowed" | "disabled" | "notConfigured" | "tooMany" | "notFound" | "unavailable";
export type ResetResult = { ok: true; password: string } | { ok: false; code: ResetCode };

export type ResetDeps = {
  /** Administrator's session: true only if this id has a judge profile (never an administrator, a parent or an unknown id). */
  isJudge(userId: string): Promise<boolean>;
  /**
   * Writes one labelled audit row (JUDGE_PASSWORD_RESET_STARTED, JUDGE_PASSWORD_RESET, JUDGE_PASSWORD_RESET_FAILED) through the service-role-only
   * database function, naming the acting administrator and the judge. Never carries a password. True only if the row was written.
   */
  record(userId: string, outcome: "started" | "success" | "failed"): Promise<boolean>;
  /** Secret key: sets the new password and the "must change password" mark. The old password is never read. */
  setPassword(userId: string, password: string): Promise<boolean>;
  email(userId: string): Promise<string | null>;
  generate?: () => string;
};

const resetSchema = z.object({ judgeId: z.uuid() });

export async function resetJudgePasswordFlow(deps: ResetDeps, raw: { judgeId: unknown }): Promise<ResetResult> {
  const parsed = resetSchema.safeParse({ judgeId: raw?.judgeId });
  if (!parsed.success) return { ok: false, code: "invalid" };
  const { judgeId } = parsed.data;

  if (!(await deps.isJudge(judgeId).catch(() => false))) return { ok: false, code: "notFound" };
  const email = (await deps.email(judgeId).catch(() => null)) ?? "";

  const generate = deps.generate ?? generatePassword;
  let password = generate();
  for (let tries = 0; passwordProblems(password, email).length > 0; tries++) {
    if (tries >= 3) return { ok: false, code: "unavailable" };
    password = generate();
  }

  // The "started" row is written first: if it cannot be written, nothing changes. The outcome row afterwards is best effort: the reset has
  // happened (or has not) whether or not it is written, and the started row remains as evidence either way.
  if (!(await deps.record(judgeId, "started").catch(() => false))) return { ok: false, code: "unavailable" };
  const done = await deps.setPassword(judgeId, password).catch(() => false);
  await deps.record(judgeId, done ? "success" : "failed").catch(() => false);
  return done ? { ok: true, password } : { ok: false, code: "unavailable" };
}

// ---- Supabase-backed dependencies --------------------------------------------------------------------------------------------------------------

/** `session` is the verified administrator's own client; the secret-key client is built here, not passed around. */
export function createProvisionDeps(session: SupabaseClient): ProvisionDeps {
  const admin = createAdminClient();
  return {
    async createUser(email, password) {
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { must_change_password: true } });
      if (error || !data.user) {
        if (error?.status === 429 || error?.code === "over_request_rate_limit") return { error: "rateLimited" };
        if (error?.code === "email_exists" || error?.code === "user_already_exists" || /already (been )?registered/i.test(error?.message ?? "")) return { error: "exists" };
        return { error: "failed" };
      }
      // The mark is what keeps this account out of the judge area until the judge chooses their own password. It is read back from the account Supabase
      // just saved; if it is not exactly true the account is removed again rather than left usable with a password an administrator knows.
      if (data.user.app_metadata?.must_change_password !== true) {
        await admin.auth.admin.deleteUser(data.user.id).catch(() => undefined);
        return { error: "failed" };
      }
      return { userId: data.user.id };
    },
    async addRole(userId) {
      return !(await session.from("user_roles").insert({ user_id: userId, role: "judge" })).error;
    },
    async addProfile(userId, displayName) {
      return !(await session.from("judge_profiles").insert({ user_id: userId, display_name: displayName, active: false })).error;
    },
    async activate(userId) {
      const { data, error } = await session.from("judge_profiles").update({ active: true }).eq("user_id", userId).select("user_id");
      return !error && data?.length === 1;
    },
    async removeProfile(userId) {
      return !(await session.from("judge_profiles").delete().eq("user_id", userId)).error;
    },
    async removeRole(userId) {
      return !(await session.from("user_roles").delete().eq("user_id", userId)).error;
    },
    async removeUser(userId) {
      return !(await admin.auth.admin.deleteUser(userId)).error;
    },
  };
}

/** `adminId` is the verified administrator's id from their own session; it is passed to the audit function, which re-checks it is an administrator. */
export function createResetDeps(session: SupabaseClient, adminId: string): ResetDeps {
  const admin = createAdminClient();
  return {
    async isJudge(userId) {
      const { data, error } = await session.from("judge_profiles").select("user_id").eq("user_id", userId).maybeSingle();
      return !error && data !== null;
    },
    async record(userId, outcome) {
      const { error } = await admin.rpc("record_judge_password_reset", { p_actor: adminId, p_judge: userId, p_outcome: outcome });
      return !error;
    },
    async setPassword(userId, password) {
      // Mark first, and confirm it from the saved account, THEN change the password: there is never a moment when a password an administrator knows
      // exists without the mark. If the second call fails the judge is left pending with the old password, which only forces a change at next sign-in.
      const marked = await admin.auth.admin.updateUserById(userId, { app_metadata: { must_change_password: true } });
      if (marked.error || marked.data.user?.app_metadata?.must_change_password !== true) return false;
      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      return !error;
    },
    async email(userId) {
      const { data } = await admin.auth.admin.getUserById(userId);
      return data.user?.email ?? null;
    },
  };
}
