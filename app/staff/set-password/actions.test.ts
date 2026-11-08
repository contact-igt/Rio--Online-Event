import { beforeEach, describe, expect, it, vi } from "vitest";

// The first-login password change, with a fake Supabase client and a recorder in place of the secret-key client. Claims: the mark is lifted only
// AFTER the judge's own password was accepted; a refused password leaves the judge blocked; if lifting fails the judge stays blocked (no bypass);
// an ordinary staff password change touches no secret-key client; nothing sensitive is returned.

const h = vi.hoisted(() => ({
  user: { id: "aaaaaaaa-0000-4000-8000-00000000000a", app_metadata: {} as Record<string, unknown> },
  role: "judge" as "admin" | "judge" | null,
  update: vi.fn(),
  admin: vi.fn(),
  adminBuilt: vi.fn(),
}));

class Redirect extends Error {}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user } }), updateUser: h.update, signOut: async () => ({ error: null }) },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    h.adminBuilt();
    return { auth: { admin: { updateUserById: h.admin } } };
  },
}));
vi.mock("@/lib/staff/auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/staff/auth")>()), staffRole: async () => h.role }));

const PASSWORD = "My-own-Passw0rd-2026";
const form = (password = PASSWORD, confirm = PASSWORD) => {
  const f = new FormData();
  f.set("password", password);
  f.set("confirm", confirm);
  return f;
};
let setPasswordAction: typeof import("./actions").setPasswordAction;
const run = async (f = form()) => {
  try {
    return { state: await setPasswordAction(undefined, f), to: null as string | null };
  } catch (e) {
    if (e instanceof Redirect) return { state: undefined, to: e.message };
    throw e;
  }
};

beforeEach(async () => {
  vi.resetModules();
  h.user = { id: "aaaaaaaa-0000-4000-8000-00000000000a", app_metadata: { must_change_password: true } };
  h.role = "judge";
  h.update.mockReset().mockResolvedValue({ error: null });
  h.admin.mockReset().mockResolvedValue({ error: null });
  h.adminBuilt.mockReset();
  ({ setPasswordAction } = await import("./actions"));
});

describe("the first-login password change", () => {
  it("saves the judge's own password, THEN lifts the mark with the secret key, and sends the judge to /judge", async () => {
    const order: string[] = [];
    h.update.mockImplementation(async () => (order.push("password"), { error: null }));
    h.admin.mockImplementation(async () => (order.push("lift"), { error: null }));
    expect(await run()).toEqual({ state: undefined, to: "/judge" });
    expect(order).toEqual(["password", "lift"]);
    expect(h.update).toHaveBeenCalledWith({ password: PASSWORD });
    expect(h.admin).toHaveBeenCalledWith(h.user.id, { app_metadata: { must_change_password: false } });
  });

  it("leaves the judge blocked when Supabase refuses the password (the same initial password, a weak one): the mark is not lifted", async () => {
    for (const code of ["same_password", "weak_password"]) {
      h.update.mockResolvedValueOnce({ error: { code, status: 422 } });
      const r = await run();
      expect(r.state).toMatchObject({ error: "weak" });
      expect(h.admin).not.toHaveBeenCalled();
    }
  });

  it("leaves the judge blocked, with a plain error, when the mark cannot be lifted (no bypass)", async () => {
    h.admin.mockResolvedValueOnce({ error: { message: "internal detail" } });
    const r = await run();
    expect(r.to).toBeNull();
    expect(r.state).toMatchObject({ error: "unavailable" });
    expect(JSON.stringify(r)).not.toContain("internal detail");
    h.admin.mockRejectedValueOnce(new Error("secret key problem"));
    expect((await run()).state).toMatchObject({ error: "unavailable" });
  });

  it("rejects short or mismatched passwords before Supabase is called", async () => {
    expect((await run(form("short", "short"))).state).toMatchObject({ error: "invalid" });
    expect((await run(form(PASSWORD, PASSWORD + "x"))).state).toMatchObject({ error: "mismatch" });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.admin).not.toHaveBeenCalled();
  });

  it("refuses a person with no staff role, and never touches the secret key for them", async () => {
    h.role = null;
    expect((await run()).state).toMatchObject({ error: "notStaff" });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.adminBuilt).not.toHaveBeenCalled();
  });

  it("an ordinary staff member (no mark) changes their password without any secret-key client", async () => {
    h.user = { ...h.user, app_metadata: {} };
    expect(await run()).toEqual({ state: undefined, to: "/judge" });
    expect(h.adminBuilt).not.toHaveBeenCalled();
  });
});
