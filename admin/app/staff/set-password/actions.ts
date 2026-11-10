"use server";

import { redirect } from "next/navigation";
import { callApi, relayCookies, sessionCookieHeader } from "@/lib/api/express";
import { currentStaff, type StaffUser } from "@/lib/staff/auth";
import { staffHome, staffLoginPath } from "@/lib/staff/paths";
import { parsePasswordChange, passwordErrorCode, type SetPasswordCode } from "@/lib/staff/password-setup";

// Changes the password of the staff member who is signed in. The API checks the current password, applies the password rules, ends every other
// session and issues a fresh one, which is relayed to the browser. Nothing here creates an account or grants a role.

export type SetPasswordState = { error?: SetPasswordCode } | undefined;

export async function setPasswordAction(_prev: SetPasswordState, formData: FormData): Promise<SetPasswordState> {
  const parsed = parsePasswordChange({ current: formData.get("current"), password: formData.get("password"), confirm: formData.get("confirm") });
  if (typeof parsed === "string") return { error: parsed };

  const cookie = await sessionCookieHeader();
  const session = cookie ? await currentStaff().catch(() => null) : null;
  if (!cookie || !session) redirect(staffLoginPath);

  const reply = await callApi<{ user?: StaffUser; error?: { code?: string } }>("/staff/password", { method: "POST", body: parsed, cookie, csrf: session.csrfToken });
  if (reply.status !== 200 || !reply.body?.user) return { error: passwordErrorCode(reply.status, reply.body?.error?.code) };

  await relayCookies(reply.setCookies);
  redirect(staffHome(reply.body.user.role));
}
