import { beforeEach, describe, expect, it, vi } from "vitest";

// Who counts as staff. The API is faked; the security claims: no cookie means nobody (and no API call), a pending password change means no
// session for any action and a redirect for every page, the wrong role is a 404, and an API failure means nobody gets in.

const h = vi.hoisted(() => ({ cookie: null as string | null, reply: { status: 200, body: null as unknown }, calls: 0 }));

class NotFound extends Error {}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("redirect"), { to });
  },
  notFound: () => {
    throw new NotFound();
  },
}));
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("../api/express", () => ({
  sessionCookieHeader: async () => h.cookie,
  callApi: async () => {
    h.calls++;
    return { ...h.reply, setCookies: [] };
  },
}));

import { requireStaff, staffSession } from "./auth";

const me = (role: "admin" | "judge", mustChangePassword = false) => ({ status: 200, body: { user: { id: 1, email: "a@rio.local", displayName: "A", role, mustChangePassword }, csrfToken: "csrf" } });

beforeEach(() => {
  h.cookie = "rio_staff=abc";
  h.reply = me("admin");
  h.calls = 0;
});

describe("staffSession (server actions)", () => {
  it("returns the session of the matching role", async () => {
    expect((await staffSession("admin"))?.csrfToken).toBe("csrf");
  });
  it("is null without a cookie, without asking the API", async () => {
    h.cookie = null;
    expect(await staffSession("admin")).toBeNull();
    expect(h.calls).toBe(0);
  });
  it("is null for the other role, a pending password change, an API error and a body without a user", async () => {
    expect(await staffSession("judge")).toBeNull();
    h.reply = me("admin", true);
    expect(await staffSession("admin")).toBeNull();
    h.reply = { status: 401, body: null };
    expect(await staffSession("admin")).toBeNull();
    h.reply = { status: 200, body: {} };
    expect(await staffSession("admin")).toBeNull();
  });
});

describe("requireStaff (pages)", () => {
  it("returns the session", async () => {
    expect((await requireStaff("admin")).user.email).toBe("a@rio.local");
  });
  it("sends a visitor with no session to the sign-in", async () => {
    h.reply = { status: 401, body: null };
    await expect(requireStaff("admin")).rejects.toMatchObject({ to: "/staff/login" });
  });
  it("sends a pending password change to /staff/set-password", async () => {
    h.reply = me("admin", true);
    await expect(requireStaff("admin")).rejects.toMatchObject({ to: "/staff/set-password" });
  });
  it("shows a plain 404 to the other role", async () => {
    h.reply = me("judge");
    await expect(requireStaff("admin")).rejects.toBeInstanceOf(NotFound);
  });
});
