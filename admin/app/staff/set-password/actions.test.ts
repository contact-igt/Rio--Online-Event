import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  reply: { status: 200, body: null as unknown, setCookies: [] as string[] },
  session: null as null | { csrfToken: string },
  calls: [] as { path: string; init: Record<string, unknown> }[],
  relayed: [] as string[][],
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
  sessionCookieHeader: async () => h.cookie,
}));
vi.mock("@/lib/staff/auth", () => ({ currentStaff: async () => h.session }));

import { setPasswordAction } from "./actions";

const form = (v: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, x] of Object.entries(v)) fd.append(k, x);
  return fd;
};
const good = { current: "old-temp-password", password: "a-long-new-password", confirm: "a-long-new-password" };
const redirectTo = async (p: Promise<unknown>) => p.then((r) => r, (e: { to?: string }) => e.to ?? null);

beforeEach(() => {
  h.reply = { status: 200, body: { user: { role: "admin" }, csrfToken: "c2" }, setCookies: ["rio_staff=rotated"] };
  h.session = { csrfToken: "c" };
  h.calls = [];
  h.relayed = [];
  h.cookie = "rio_staff=tok";
});

describe("setPasswordAction", () => {
  it("sends both passwords with the CSRF token, relays the rotated session cookie and goes to /admin", async () => {
    expect(await redirectTo(setPasswordAction(undefined, form(good)))).toBe("/admin");
    expect(h.calls[0]).toMatchObject({ path: "/staff/password", init: { method: "POST", csrf: "c", body: { currentPassword: good.current, newPassword: good.password } } });
    expect(h.relayed).toEqual([["rio_staff=rotated"]]);
  });
  it("needs a signed-in session", async () => {
    h.session = null;
    expect(await redirectTo(setPasswordAction(undefined, form(good)))).toBe("/staff/login");
    expect(h.calls).toEqual([]);
  });
  it("checks the repeat locally, without calling the API", async () => {
    expect(await setPasswordAction(undefined, form({ ...good, confirm: "different-password" }))).toEqual({ error: "mismatch" });
    expect(h.calls).toEqual([]);
  });
  it.each([
    [422, "weak_password", "weak"],
    [403, "current_password_incorrect", "current"],
    [429, "rate_limited", "tooMany"],
    [500, undefined, "unavailable"],
  ])("answers %i with %s as %s and relays nothing", async (status, code, error) => {
    h.reply = { status, body: { error: { code } }, setCookies: ["rio_staff=x"] };
    expect(await setPasswordAction(undefined, form(good))).toEqual({ error });
    expect(h.relayed).toEqual([]);
  });
});
