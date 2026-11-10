import { beforeEach, describe, expect, it, vi } from "vitest";

// Staff sign-in and sign-out with a fake API. Claims: a failure is generic, only the email is put back, the API's session cookie is relayed on
// success, a pending password change goes to /staff/set-password, and signing out always clears this browser's cookie.

const h = vi.hoisted(() => ({
  reply: { status: 200, body: null as unknown, setCookies: [] as string[] },
  session: null as null | { csrfToken: string },
  calls: [] as { path: string; init: Record<string, unknown> }[],
  relayed: [] as string[][],
  forgotten: 0,
  cookie: "rio_staff=tok" as string | null,
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("redirect"), { to });
  },
}));
vi.mock("@/lib/api/express", () => ({
  callApi: async (path: string, init: Record<string, unknown>) => {
    h.calls.push({ path, init });
    return h.reply;
  },
  relayCookies: async (c: string[]) => void h.relayed.push(c),
  forgetSessionCookie: async () => void h.forgotten++,
  sessionCookieHeader: async () => h.cookie,
}));
vi.mock("@/lib/staff/auth", () => ({ currentStaff: async () => h.session }));

import { staffSignIn, staffSignOut } from "./actions";

const form = (v: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, x] of Object.entries(v)) fd.append(k, x);
  return fd;
};
const user = (role: string, mustChangePassword = false) => ({ user: { id: 1, email: "a@rio.local", displayName: "A", role, mustChangePassword }, csrfToken: "c" });
const redirectTo = async (p: Promise<unknown>) => p.then(() => null, (e: { to?: string }) => e.to ?? null);

beforeEach(() => {
  h.reply = { status: 200, body: user("admin"), setCookies: ["rio_staff=new; HttpOnly"] };
  h.session = { csrfToken: "c" };
  h.calls = [];
  h.relayed = [];
  h.forgotten = 0;
  h.cookie = "rio_staff=tok";
});

describe("staffSignIn", () => {
  it("relays the cookie and goes to /admin", async () => {
    expect(await redirectTo(staffSignIn(undefined, form({ email: "Admin@Rio.local", password: "pw" })))).toBe("/admin");
    expect(h.relayed).toEqual([["rio_staff=new; HttpOnly"]]);
    expect(h.calls[0]).toMatchObject({ path: "/staff/login", init: { method: "POST", body: { email: "admin@rio.local", password: "pw" } } });
  });
  it("goes to /staff/set-password while the password must be changed", async () => {
    h.reply.body = user("admin", true);
    expect(await redirectTo(staffSignIn(undefined, form({ email: "a@rio.local", password: "pw" })))).toBe("/staff/set-password");
  });
  it("sends a judge to /judge", async () => {
    h.reply.body = user("judge");
    expect(await redirectTo(staffSignIn(undefined, form({ email: "j@rio.local", password: "pw" })))).toBe("/judge");
  });
  it.each([[401, "credentials"], [429, "tooMany"], [500, "unavailable"], [0, "unavailable"]])("answers %i with %s, puts back only the email and relays nothing", async (status, error) => {
    h.reply = { status, body: null, setCookies: ["rio_staff=x"] };
    const state = await staffSignIn(undefined, form({ email: "a@rio.local", password: "secret-pw" }));
    expect(state).toEqual({ error, email: "a@rio.local" });
    expect(JSON.stringify(state)).not.toContain("secret-pw");
    expect(h.relayed).toEqual([]);
  });
  it("does not call the API for input that is plainly invalid", async () => {
    expect(await staffSignIn(undefined, form({ email: "nope", password: "" }))).toMatchObject({ error: "invalid" });
    expect(h.calls).toEqual([]);
  });
});

describe("staffSignOut", () => {
  it("ends the session with the CSRF token, clears the cookie and goes to the sign-in", async () => {
    expect(await redirectTo(staffSignOut())).toBe("/staff/login");
    expect(h.calls[0]).toMatchObject({ path: "/staff/logout", init: { method: "POST", csrf: "c", cookie: "rio_staff=tok" } });
    expect(h.forgotten).toBe(1);
  });
  it("clears the cookie even when there is no session", async () => {
    h.session = null;
    expect(await redirectTo(staffSignOut())).toBe("/staff/login");
    expect(h.calls).toEqual([]);
    expect(h.forgotten).toBe(1);
  });
});
