import { beforeEach, describe, expect, it, vi } from "vitest";

// Who counts as staff, with a fake Supabase client. The security claims: an inactive judge is nobody; a judge who still has the password an
// administrator set (the app_metadata mark) gets no session for any action and is sent to choose a password for every page; the mark is read from
// the user Supabase just verified, never from anything the person can edit.

const h = vi.hoisted(() => ({
  user: null as null | { id: string; app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> },
  role: null as null | "admin" | "judge",
  active: true,
}));

class Redirect extends Error {}
class NotFound extends Error {}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
  notFound: () => {
    throw new NotFound();
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user } }) },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: table === "user_roles" ? (h.role ? { role: h.role } : null) : { active: h.active } }),
        }),
      }),
    }),
  }),
}));

const ID = "aaaaaaaa-0000-4000-8000-00000000000a";
let auth: typeof import("./auth");
beforeEach(async () => {
  vi.resetModules();
  h.user = { id: ID };
  h.role = "judge";
  h.active = true;
  auth = await import("./auth");
});

const outcome = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof Redirect ? `redirect:${e.message}` : e instanceof NotFound ? "404" : "error";
  }
};

describe("an ordinary active judge", () => {
  it("gets a session for the judge role and the page", async () => {
    expect((await auth.staffSession("judge"))?.role).toBe("judge");
    expect(await outcome(auth.requireStaff("judge"))).toBe("ok");
  });

  it("does not get the administrator role", async () => {
    expect(await auth.staffSession("admin")).toBeNull();
    expect(await outcome(auth.requireStaff("admin"))).toBe("404");
  });
});

describe("a deactivated judge", () => {
  it("is nobody: no session, a plain 404 on pages", async () => {
    h.active = false;
    expect(await auth.staffSession("judge")).toBeNull();
    expect(await outcome(auth.requireStaff("judge"))).toBe("404");
  });
});

describe("first-login password change", () => {
  beforeEach(() => {
    h.user = { id: ID, app_metadata: { must_change_password: true } };
  });

  it("gives no session at all, so no scoring, playback or admin action can run, until the password is changed", async () => {
    expect(await auth.staffSession("judge")).toBeNull();
    h.role = "admin";
    expect(await auth.staffSession("admin")).toBeNull();
  });

  it("sends every staff page to the set-password page", async () => {
    expect(await outcome(auth.requireStaff("judge"))).toBe("redirect:/staff/set-password");
  });

  it("still sends a person with the wrong role to a 404 rather than revealing the page, and a signed-out visitor to sign in", async () => {
    expect(await outcome(auth.requireStaff("admin"))).toBe("404");
    h.user = null;
    expect(await outcome(auth.requireStaff("judge"))).toBe("redirect:/staff/login");
  });

  it("lets the person in once the mark is lifted (false, absent or null)", async () => {
    for (const meta of [{ must_change_password: false }, {}, { must_change_password: null }, undefined]) {
      h.user = { id: ID, app_metadata: meta };
      expect((await auth.staffSession("judge"))?.role).toBe("judge");
    }
  });

  it("ignores a look-alike in user_metadata, which the person can edit themselves", async () => {
    h.user = { id: ID, user_metadata: { must_change_password: false }, app_metadata: { must_change_password: true } };
    expect(await auth.staffSession("judge")).toBeNull();
    h.user = { id: ID, user_metadata: { must_change_password: true } };
    expect((await auth.staffSession("judge"))?.role).toBe("judge"); // only app_metadata counts, and only the secret key writes it
  });

  it("only the exact value true counts as pending", async () => {
    for (const v of ["true", 1, "yes"]) {
      h.user = { id: ID, app_metadata: { must_change_password: v } };
      expect(auth.mustChangePassword(h.user as never)).toBe(false);
    }
    expect(auth.mustChangePassword({ app_metadata: { must_change_password: true } } as never)).toBe(true);
  });
});

describe("a person with no staff role", () => {
  it("gets nothing, whatever the mark says", async () => {
    h.role = null;
    expect(await auth.staffSession("judge")).toBeNull();
    expect(await outcome(auth.requireStaff("judge"))).toBe("404");
  });
});
