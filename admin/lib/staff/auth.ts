import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { callApi, sessionCookieHeader } from "../api/express";
import { staffLoginPath, staffPasswordPath, type StaffRole } from "./paths";

// Who is signed in as staff, as the Express API says. The API looks the session up in its database on every request, re-reading the role and
// whether the account is still active, so nothing here trusts the cookie's content: the cookie is an opaque random token.
// This only decides what a page shows. Every change goes through the API again, which checks the session, the role and the CSRF token itself.

export type { StaffRole };
export type StaffUser = { id: number; email: string; displayName: string; role: StaffRole; mustChangePassword: boolean };
export type StaffSession = { user: StaffUser; role: StaffRole; csrfToken: string };
type MeBody = { user: StaffUser; csrfToken: string };

/** An account whose password was set by an administrator (creation or reset) must choose its own before anything else. */
export const mustChangePassword = (user: Pick<StaffUser, "mustChangePassword">): boolean => user.mustChangePassword;

/** The signed-in member of either role, or null. Asked once per request however many components want it. */
export const currentStaff = cache(async (): Promise<StaffSession | null> => {
  const cookie = await sessionCookieHeader();
  if (!cookie) return null; // nothing to ask the API about
  const reply = await callApi<MeBody>("/staff/me", { cookie });
  if (reply.status !== 200 || !reply.body?.user || typeof reply.body.csrfToken !== "string") return null;
  return { user: reply.body.user, role: reply.body.user.role, csrfToken: reply.body.csrfToken };
});

/** For server actions: the verified staff session of this role, or null. Never throws. Null as well while a password change is pending, so no action runs. */
export async function staffSession(role: StaffRole): Promise<StaffSession | null> {
  try {
    const session = await currentStaff();
    return session && session.role === role && !mustChangePassword(session.user) ? session : null;
  } catch {
    return null;
  }
}

/** For pages: not signed in goes to the staff sign-in; a pending password change goes to /staff/set-password; signed in with another role sees a plain 404 (the area is not advertised). */
export async function requireStaff(role: StaffRole): Promise<StaffSession> {
  let session: StaffSession | null = null;
  try {
    session = await currentStaff();
  } catch {
    session = null;
  }
  if (!session) redirect(staffLoginPath);
  if (session.role !== role) notFound();
  if (mustChangePassword(session.user)) redirect(staffPasswordPath);
  return session;
}
