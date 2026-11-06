import { beforeEach, describe, expect, it, vi } from "vitest";

// The staff sign-in and sign-out server actions with a fake Supabase client: roles decide where a person goes, every failure is
// generic, nothing sensitive comes back, and the limits apply per address and per email.

const h = vi.hoisted(() => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
  role: null as "admin" | "judge" | null,
  ip: "203.0.113.7",
  configBroken: false,
}));

class Redirect extends Error {}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": h.ip }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (h.configBroken) throw new Error("Supabase URL or publishable key is not configured.");
    return { auth: { signInWithPassword: h.signIn, signOut: h.signOut } };
  },
}));
vi.mock("@/lib/staff/auth", () => ({ staffRole: async () => h.role }));

type Actions = typeof import("./actions");
let actions: Actions;
const PASSWORD = "correct-horse-battery-staple-1";
const form = (email: string, password: string) => {
  const f = new FormData();
  f.set("email", email);
  f.set("password", password);
  return f;
};
const attempt = (email = "admin@example.org", password = PASSWORD) => actions.staffSignIn(undefined, form(email, password));
const redirected = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof Redirect) return e.message;
    throw e;
  }
  return null;
};

beforeEach(async () => {
  vi.resetModules();
  h.signIn.mockReset().mockResolvedValue({ data: { user: { id: "aaaaaaaa-0000-4000-8000-00000000000a" } }, error: null });
  h.signOut.mockReset().mockResolvedValue({ error: null });
  h.role = "admin";
  h.ip = "203.0.113.7";
  h.configBroken = false;
  actions = await import("./actions");
});

describe("staffSignIn", () => {
  it("sends an administrator to /admin and an active judge to /judge", async () => {
    h.role = "admin";
    expect(await redirected(attempt())).toBe("/admin");
    h.role = "judge";
    expect(await redirected(attempt("judge@example.org"))).toBe("/judge");
    expect(h.signIn).toHaveBeenCalledWith({ email: "judge@example.org", password: PASSWORD });
  });

  it("a wrong password gets the generic answer, keeps only the email, and never redirects", async () => {
    h.signIn.mockResolvedValue({ data: { user: null }, error: { status: 400, code: "invalid_credentials", message: "Invalid login credentials" } });
    const state = await attempt("admin@example.org", "wrong-password-123");
    expect(state).toEqual({ error: "credentials", email: "admin@example.org" });
    expect(JSON.stringify(state)).not.toContain("wrong-password-123");
  });

  it("a parent (a password sign-in fails for them) and an account with no staff role are refused, and no session is left behind", async () => {
    h.signIn.mockResolvedValue({ data: { user: null }, error: { status: 400, code: "invalid_credentials" } });
    expect(await attempt("parent@example.org")).toMatchObject({ error: "credentials" });
    h.signIn.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    h.role = null;
    expect(await attempt("someone@example.org")).toEqual({ error: "notStaff", email: "someone@example.org" });
    expect(h.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  });

  it("an inactive judge (no role comes back) is refused", async () => {
    h.role = null;
    expect(await attempt("judge@example.org")).toMatchObject({ error: "notStaff" });
    expect(h.signOut).toHaveBeenCalledOnce();
  });

  it("rate limits and outages are reported plainly, without provider text", async () => {
    h.signIn.mockResolvedValue({ data: { user: null }, error: { status: 429, code: "over_request_rate_limit", message: "secret@leak.test" } });
    expect(await attempt()).toEqual({ error: "tooMany", email: "admin@example.org" });
    h.signIn.mockResolvedValue({ data: { user: null }, error: { status: 500, message: "boom https://x.supabase.co" } });
    const state = await attempt();
    expect(state).toEqual({ error: "unavailable", email: "admin@example.org" });
    expect(JSON.stringify(state)).not.toMatch(/boom|supabase|leak/);
    h.configBroken = true;
    expect(await attempt()).toEqual({ error: "unavailable", email: "admin@example.org" });
  });

  it("malformed form data never reaches Supabase", async () => {
    const f = new FormData();
    f.set("email", "x");
    expect(await actions.staffSignIn(undefined, f)).toMatchObject({ error: "invalid" });
    expect(await actions.staffSignIn(undefined, new FormData())).toMatchObject({ error: "invalid" });
    expect(h.signIn).not.toHaveBeenCalled();
  });

  it("limits attempts per email (6 per 10 minutes), a success clears that email's count, and other emails are unaffected", async () => {
    h.signIn.mockResolvedValue({ data: { user: null }, error: { status: 400, code: "invalid_credentials" } });
    for (let i = 0; i < 6; i++) expect(await attempt("victim@example.org"), String(i)).toMatchObject({ error: "credentials" });
    expect(await attempt("victim@example.org")).toMatchObject({ error: "tooMany" });
    expect(h.signIn).toHaveBeenCalledTimes(6);
    h.ip = "198.51.100.9";
    expect(await attempt("other@example.org")).toMatchObject({ error: "credentials" });
  });

  it("limits attempts per address (15 per 10 minutes)", async () => {
    h.signIn.mockResolvedValue({ data: { user: null }, error: { status: 400, code: "invalid_credentials" } });
    for (let i = 0; i < 15; i++) expect(await attempt(`user${i}@example.org`), String(i)).toMatchObject({ error: "credentials" });
    expect(await attempt("user99@example.org")).toMatchObject({ error: "tooMany" });
  });

  it("never logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    h.signIn.mockResolvedValue({ data: { user: null }, error: { status: 400, code: "invalid_credentials" } });
    await attempt();
    h.configBroken = true;
    await attempt();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("staffSignOut", () => {
  it("signs out this browser only and returns to the staff sign-in", async () => {
    expect(await redirected(actions.staffSignOut())).toBe("/staff/login");
    expect(h.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  });
  it("still returns to the sign-in when Supabase is unreachable or not configured", async () => {
    h.signOut.mockRejectedValue(new Error("network"));
    expect(await redirected(actions.staffSignOut())).toBe("/staff/login");
    h.configBroken = true;
    expect(await redirected(actions.staffSignOut())).toBe("/staff/login");
  });
});
