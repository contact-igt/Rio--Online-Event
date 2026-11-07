import { beforeEach, describe, expect, it, vi } from "vitest";

// The administrator-only judge actions. The security claims: a signed-out caller, a parent and a judge (all of whom make staffSession("admin")
// answer null) get "notAllowed" and NOTHING else happens: no setting is read, no Auth Admin dependency is built, no database call is made.
// No real invitation, account or e-mail is involved: the invitation dependencies are replaced by recorders.

const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string }; supabase: unknown },
  deps: vi.fn(),
  revalidate: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/staff/auth", () => ({ staffSession: async () => h.session }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
vi.mock("@/lib/staff/invites", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/staff/invites")>()), createInviteDeps: h.deps }));

const ADMIN_ENV = { RIO_STAFF_INVITES_ENABLED: "yes", SUPABASE_SECRET_KEY: "sb_secret_abcdefghijklmnop" };
const J = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
let n = 0;

function admin() {
  n += 1; // a fresh user id per test so the in-memory rate limit never leaks between tests
  return {
    user: { id: `admin-${n}` },
    supabase: { from: () => ({ update: (v: unknown) => ({ eq: (c: string, id: string) => ({ select: () => h.update(v, c, id) }) }) }) },
  };
}
const good = { email: "new.judge@example.test", displayName: "New Judge" };

beforeEach(() => {
  vi.unstubAllEnvs();
  h.session = null;
  h.deps.mockReset();
  h.revalidate.mockReset();
  h.update.mockReset();
});

describe("inviteJudge", () => {
  it("is refused for a signed-out caller, a parent and a judge, before any setting is read or any dependency built", async () => {
    for (const [k, v] of Object.entries(ADMIN_ENV)) vi.stubEnv(k, v); // even fully configured
    const { inviteJudge } = await import("./actions");
    h.session = null;
    expect(await inviteJudge(good)).toEqual({ ok: false, code: "notAllowed" });
    expect(h.deps).not.toHaveBeenCalled();
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  it("says invitations are switched off, and builds nothing, while the switch is not exactly yes", async () => {
    const { inviteJudge } = await import("./actions");
    for (const v of [undefined, "no", "YES", "true"]) {
      vi.stubEnv("SUPABASE_SECRET_KEY", ADMIN_ENV.SUPABASE_SECRET_KEY);
      if (v !== undefined) vi.stubEnv("RIO_STAFF_INVITES_ENABLED", v);
      h.session = admin();
      expect(await inviteJudge(good)).toEqual({ ok: false, code: "disabled" });
    }
    expect(h.deps).not.toHaveBeenCalled();
  });

  it("says the server is not configured when the secret key is missing or malformed, and builds nothing", async () => {
    const { inviteJudge } = await import("./actions");
    vi.stubEnv("RIO_STAFF_INVITES_ENABLED", "yes");
    h.session = admin();
    expect(await inviteJudge(good)).toEqual({ ok: false, code: "notConfigured" });
    vi.stubEnv("SUPABASE_SECRET_KEY", "not-a-secret-key");
    h.session = admin();
    expect(await inviteJudge(good)).toEqual({ ok: false, code: "notConfigured" });
    expect(h.deps).not.toHaveBeenCalled();
  });

  it("for a verified administrator with everything configured, runs the invitation with the administrator's own session and refreshes the list", async () => {
    for (const [k, v] of Object.entries(ADMIN_ENV)) vi.stubEnv(k, v);
    const { inviteJudge } = await import("./actions");
    const recorded: string[] = [];
    h.deps.mockReturnValue({
      judgeEmails: async () => [],
      invite: async (e: string) => (recorded.push(e), { user: { userId: "u1", createdAt: new Date().toISOString(), lastSignInAt: null } }),
      provision: async () => true,
      remove: async () => true,
    });
    const session = admin();
    h.session = session;
    expect(await inviteJudge(good)).toEqual({ ok: true });
    expect(recorded).toEqual(["new.judge@example.test"]);
    expect(h.deps).toHaveBeenCalledExactlyOnceWith(session.supabase);
    expect(h.revalidate).toHaveBeenCalledWith("/admin/judges");
  });

  it("an unexpected failure is a plain inviteFailed, and the input is validated (bad input never reaches Auth)", async () => {
    for (const [k, v] of Object.entries(ADMIN_ENV)) vi.stubEnv(k, v);
    const { inviteJudge } = await import("./actions");
    h.deps.mockImplementation(() => {
      throw new Error("secret key problem");
    });
    h.session = admin();
    expect(await inviteJudge(good)).toEqual({ ok: false, code: "inviteFailed" });
    h.deps.mockReturnValue({ judgeEmails: async () => [], invite: vi.fn(), provision: vi.fn(), remove: vi.fn() });
    h.session = admin();
    expect(await inviteJudge({ email: "not an email", displayName: "x" })).toEqual({ ok: false, code: "invalid" });
  });

  it("is rate-limited per administrator", async () => {
    for (const [k, v] of Object.entries(ADMIN_ENV)) vi.stubEnv(k, v);
    vi.resetModules();
    const { inviteJudge } = await import("./actions");
    h.deps.mockReturnValue({ judgeEmails: async () => [], invite: async () => ({ error: "failed" }), provision: vi.fn(), remove: vi.fn() });
    const session = admin();
    h.session = session;
    let last;
    for (let i = 0; i < 11; i++) last = await inviteJudge(good);
    expect(last).toEqual({ ok: false, code: "tooMany" });
  });
});

describe("setJudgeActive", () => {
  it("is refused for anyone who is not a verified administrator, with no database call", async () => {
    const { setJudgeActive } = await import("./actions");
    expect(await setJudgeActive({ judgeId: J, active: true })).toEqual({ ok: false, code: "notAllowed" });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("refuses a bad id, and refuses to deactivate without an explicit confirmation (the server enforces it, not only the screen)", async () => {
    const { setJudgeActive } = await import("./actions");
    h.session = admin();
    expect(await setJudgeActive({ judgeId: "not-a-uuid", active: true })).toEqual({ ok: false, code: "invalid" });
    for (const confirmed of [undefined, false]) expect(await setJudgeActive({ judgeId: J, active: false, confirmed })).toEqual({ ok: false, code: "confirmRequired" });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("deactivates with the administrator's own session once confirmed, and activating needs no confirmation", async () => {
    const { setJudgeActive } = await import("./actions");
    h.session = admin();
    h.update.mockResolvedValue({ data: [{ user_id: J }], error: null });
    expect(await setJudgeActive({ judgeId: J, active: false, confirmed: true })).toEqual({ ok: true });
    expect(h.update).toHaveBeenLastCalledWith({ active: false }, "user_id", J);
    expect(await setJudgeActive({ judgeId: J, active: true })).toEqual({ ok: true });
    expect(h.update).toHaveBeenLastCalledWith({ active: true }, "user_id", J);
    expect(h.revalidate).toHaveBeenCalledWith("/admin/judges");
  });

  it("reports a judge that does not exist, a refusal by row level security, and a failure, without detail", async () => {
    const { setJudgeActive } = await import("./actions");
    h.session = admin();
    h.update.mockResolvedValueOnce({ data: [], error: null });
    expect(await setJudgeActive({ judgeId: J, active: true })).toEqual({ ok: false, code: "notFound" });
    h.update.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "permission denied for table x" } });
    expect(await setJudgeActive({ judgeId: J, active: true })).toEqual({ ok: false, code: "notAllowed" });
    h.update.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "internal detail" } });
    const r = await setJudgeActive({ judgeId: J, active: true });
    expect(r).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(r)).not.toContain("internal detail");
  });
});
