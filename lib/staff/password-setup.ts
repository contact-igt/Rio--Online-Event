import { z } from "zod";
import type { StaffRole } from "./paths";

// A judge (or administrator) chooses a password from the one-time link in the invitation e-mail. Plain functions with dependencies passed in:
//   * the password goes from the form to Supabase Auth (updateUser) and nowhere else. It is never logged, stored, put in a URL, returned or
//     echoed back into the form;
//   * the one-time token is checked by Supabase Auth (verifyOtp) when the form is SENT, not when the page opens, so an e-mail scanner that
//     only opens the link cannot use it up;
//   * a signed-in person without a staff role is signed out again and refused (a stray link must never leave a parent signed in here);
//   * if Supabase refuses a weak password, the token is already used: the person stays signed in and the form continues in "session" mode,
//     where it changes the password of the signed-in staff member only (never of someone else).

export type SetPasswordCode = "invalid" | "mismatch" | "weak" | "linkInvalid" | "notStaff" | "tooMany" | "unavailable";
export type SetPasswordResult = { ok: true; role: StaffRole } | { ok: false; code: SetPasswordCode; session?: boolean };

export type SetPasswordDeps = {
  verify(tokenHash: string, type: "invite" | "recovery"): Promise<{ userId: string } | { error: "link" | "unavailable" }>;
  /** The staff member already signed in (session mode). */
  currentUser(): Promise<{ userId: string } | null>;
  setPassword(password: string): Promise<"ok" | "weak" | "unavailable">;
  roleOf(userId: string): Promise<StaffRole | null>;
  signOut(): Promise<void>;
};

const input = z
  .object({
    password: z.string().min(12).max(128),
    confirm: z.string().max(128),
    tokenHash: z.string().regex(/^[A-Za-z0-9_-]{8,200}$/).optional(),
    type: z.enum(["invite", "recovery"]).optional(),
  })
  .refine((v) => (v.tokenHash === undefined) === (v.type === undefined));

export async function setStaffPassword(deps: SetPasswordDeps, raw: { password: unknown; confirm: unknown; tokenHash?: unknown; type?: unknown }): Promise<SetPasswordResult> {
  const parsed = input.safeParse({ password: raw.password, confirm: raw.confirm, tokenHash: raw.tokenHash || undefined, type: raw.type || undefined });
  if (!parsed.success) return { ok: false, code: "invalid" };
  if (parsed.data.password !== parsed.data.confirm) return { ok: false, code: "mismatch" };
  const { password, tokenHash, type } = parsed.data;

  let userId: string;
  try {
    if (tokenHash && type) {
      const verified = await deps.verify(tokenHash, type);
      if ("error" in verified) return { ok: false, code: verified.error === "link" ? "linkInvalid" : "unavailable" };
      userId = verified.userId;
    } else {
      const current = await deps.currentUser();
      if (!current) return { ok: false, code: "linkInvalid" };
      userId = current.userId;
    }
    // A signed-in person who holds no staff role never gets to set a password here.
    if ((await deps.roleOf(userId)) === null) {
      await deps.signOut();
      return { ok: false, code: "notStaff" };
    }
    const done = await deps.setPassword(password);
    if (done === "weak") return { ok: false, code: "weak", session: true };
    if (done !== "ok") return { ok: false, code: "unavailable", session: Boolean(tokenHash) };
    const role = await deps.roleOf(userId);
    return role ? { ok: true, role } : { ok: false, code: "notStaff" };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}
