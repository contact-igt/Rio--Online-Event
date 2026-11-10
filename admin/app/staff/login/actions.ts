"use server";

import { redirect } from "next/navigation";
import { callApi, forgetSessionCookie, relayCookies, sessionCookieHeader } from "@/lib/api/express";
import { currentStaff, type StaffUser } from "@/lib/staff/auth";
import { loginErrorCode, parseLogin, type LoginCode } from "@/lib/staff/login";
import { staffHome, staffLoginPath, staffPasswordPath } from "@/lib/staff/paths";

// Staff sign-in and sign-out through the Express API. The password goes from the form to the API and nowhere else: never logged, stored,
// returned, put in a URL, or echoed back into the form (only the email is). Rate limiting is the API's (per address and per email).

export type StaffLoginState = { error?: LoginCode; email?: string } | undefined;

export async function staffSignIn(_prev: StaffLoginState, formData: FormData): Promise<StaffLoginState> {
  const rawEmail = formData.get("email");
  const email = typeof rawEmail === "string" ? rawEmail : "";
  const parsed = parseLogin({ email, password: formData.get("password") });
  if (!parsed) return { error: "invalid", email };

  const reply = await callApi<{ user?: StaffUser }>("/staff/login", { method: "POST", body: parsed });
  if (reply.status !== 200 || !reply.body?.user) return { error: loginErrorCode(reply.status), email };

  await relayCookies(reply.setCookies);
  const user = reply.body.user;
  redirect(user.mustChangePassword ? staffPasswordPath : staffHome(user.role)); // outside try/catch: redirect() works by throwing
}

export async function staffSignOut(): Promise<void> {
  const cookie = await sessionCookieHeader();
  if (cookie) {
    const session = await currentStaff().catch(() => null);
    if (session) await callApi("/staff/logout", { method: "POST", cookie, csrf: session.csrfToken });
  }
  await forgetSessionCookie(); // whatever the API said, this browser no longer holds the session
  redirect(staffLoginPath);
}
