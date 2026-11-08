import { beforeEach, describe, expect, it, vi } from "vitest";

// The administrator-only judge actions. The security claims: a signed-out caller, a parent and a judge (all of whom make staffSession("admin")
// answer null) get "notAllowed" and NOTHING else happens: no setting is read, no Auth Admin dependency is built, no database call is made.
// No real invitation, account or e-mail is involved: the invitation dependencies are replaced by recorders.

const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string }; supabase: unknown },
  deps: vi.fn(),
  pdeps: vi.fn(),
  rdeps: vi.fn(),
  revalidate: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/staff/auth", () => ({ staffSession: async () => h.session }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
vi.mock("@/lib/staff/invites", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/staff/invites")>()), createInviteDeps: h.deps }));

vi.mock("@/lib/staff/provisioning", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staff/provisioning")>()),
  createProvisionDeps: h.pdeps,
  createResetDeps: h.rdeps,
}));

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
  h.pdeps.mockReset();
  h.rdeps.mockReset();
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

// ---- manual judge accounts ------------------------------------------------------------------------------------------------------------------
// Its own switch (RIO_STAFF_PROVISIONING_ENABLED); the invitations switch must not open it. Supabase is replaced by recorders.

const PROV_ENV = { RIO_STAFF_PROVISIONING_ENABLED: "yes", SUPABASE_SECRET_KEY: ADMIN_ENV.SUPABASE_SECRET_KEY };
const create = { email: "new.judge@example.test", displayName: "New Judge", emailVerified: true };
const FIXED = "Kd7m-Qp3x-Wn8c-Rt5v-Hj2f";
function provDeps(log: string[]) {
  return {
    generate: () => FIXED,
    createUser: async (e: string) => (log.push(`create:${e}`), { userId: J }),
    addRole: async () => (log.push("role"), true),
    addProfile: async () => (log.push("profile"), true),
    activate: async () => (log.push("activate"), true),
    removeProfile: async () => true,
    removeRole: async () => true,
    removeUser: async () => true,
  };
}

describe("provisionJudge", () => {
  it("cannot be used by a signed-out caller, a parent or a judge: nothing is read, built or created", async () => {
    for (const [k, v] of Object.entries(PROV_ENV)) vi.stubEnv(k, v); // even fully configured
    const { provisionJudge } = await import("./actions");
    h.session = null; // staffSession("admin") answers null for all three
    expect(await provisionJudge(create)).toEqual({ ok: false, code: "notAllowed" });
    expect(h.pdeps).not.toHaveBeenCalled();
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  it("is blocked while the provisioning switch is not exactly yes, whatever the invitations switch says, and builds nothing", async () => {
    const { provisionJudge } = await import("./actions");
    for (const v of [undefined, "no", "YES", "true", "1"]) {
      vi.stubEnv("SUPABASE_SECRET_KEY", PROV_ENV.SUPABASE_SECRET_KEY);
      vi.stubEnv("RIO_STAFF_INVITES_ENABLED", "yes"); // the other switch must not unlock this
      if (v !== undefined) vi.stubEnv("RIO_STAFF_PROVISIONING_ENABLED", v);
      else vi.stubEnv("RIO_STAFF_PROVISIONING_ENABLED", "");
      h.session = admin();
      expect(await provisionJudge(create)).toEqual({ ok: false, code: "disabled" });
    }
    expect(h.pdeps).not.toHaveBeenCalled();
  });

  it("says the server is not configured when the secret key is missing or malformed, and builds nothing", async () => {
    const { provisionJudge } = await import("./actions");
    vi.stubEnv("RIO_STAFF_PROVISIONING_ENABLED", "yes");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    h.session = admin();
    expect(await provisionJudge(create)).toEqual({ ok: false, code: "notConfigured" });
    vi.stubEnv("SUPABASE_SECRET_KEY", "not-a-secret-key");
    h.session = admin();
    expect(await provisionJudge(create)).toEqual({ ok: false, code: "notConfigured" });
    expect(h.pdeps).not.toHaveBeenCalled();
  });

  it("for a verified administrator with the switch on, creates the judge with the administrator's own session and returns the password once", async () => {
    for (const [k, v] of Object.entries(PROV_ENV)) vi.stubEnv(k, v);
    const { provisionJudge } = await import("./actions");
    const log: string[] = [];
    h.pdeps.mockReturnValue(provDeps(log));
    const session = admin();
    h.session = session;
    expect(await provisionJudge(create)).toEqual({ ok: true, email: "new.judge@example.test", password: FIXED });
    expect(log).toEqual(["create:new.judge@example.test", "role", "profile", "activate"]);
    expect(h.pdeps).toHaveBeenCalledExactlyOnceWith(session.supabase);
    expect(h.revalidate).toHaveBeenCalledWith("/admin/judges");
  });

  it("does not create anything for a bad address or an unconfirmed address, and an unexpected failure is a plain createFailed", async () => {
    for (const [k, v] of Object.entries(PROV_ENV)) vi.stubEnv(k, v);
    const { provisionJudge } = await import("./actions");
    const log: string[] = [];
    h.pdeps.mockReturnValue(provDeps(log));
    h.session = admin();
    expect(await provisionJudge({ ...create, email: "not an email" })).toEqual({ ok: false, code: "invalid" });
    expect(await provisionJudge({ ...create, emailVerified: false })).toEqual({ ok: false, code: "emailNotConfirmed" });
    expect(log).toEqual([]);
    h.pdeps.mockImplementation(() => {
      throw new Error("secret key problem");
    });
    expect(await provisionJudge(create)).toEqual({ ok: false, code: "createFailed" });
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  it("is rate-limited per administrator", async () => {
    for (const [k, v] of Object.entries(PROV_ENV)) vi.stubEnv(k, v);
    vi.resetModules();
    const { provisionJudge } = await import("./actions");
    h.pdeps.mockReturnValue({ ...provDeps([]), createUser: async () => ({ error: "failed" }) });
    h.session = admin();
    let last;
    for (let i = 0; i < 11; i++) last = await provisionJudge(create);
    expect(last).toEqual({ ok: false, code: "tooMany" });
  });
});

describe("resetJudgePassword", () => {
  const resetDeps = (log: string[]) => ({
    generate: () => FIXED,
    isJudge: async () => true,
    email: async () => "judge.one@example.test",
    record: async (_id: string, outcome: string) => (log.push(`record:${outcome}`), true),
    setPassword: async () => (log.push("set"), true),
  });

  it("is refused for anyone who is not a verified administrator, and when the switch is off, before any password is touched", async () => {
    const { resetJudgePassword } = await import("./actions");
    vi.stubEnv("RIO_STAFF_PROVISIONING_ENABLED", "yes");
    vi.stubEnv("SUPABASE_SECRET_KEY", PROV_ENV.SUPABASE_SECRET_KEY);
    h.session = null;
    expect(await resetJudgePassword({ judgeId: J })).toEqual({ ok: false, code: "notAllowed" });
    vi.stubEnv("RIO_STAFF_PROVISIONING_ENABLED", "no");
    h.session = admin();
    expect(await resetJudgePassword({ judgeId: J })).toEqual({ ok: false, code: "disabled" });
    expect(h.rdeps).not.toHaveBeenCalled();
  });

  it("for a verified administrator, records the audit rows, sets the new password and returns it once", async () => {
    for (const [k, v] of Object.entries(PROV_ENV)) vi.stubEnv(k, v);
    const { resetJudgePassword } = await import("./actions");
    const log: string[] = [];
    h.rdeps.mockReturnValue(resetDeps(log));
    const session = admin();
    h.session = session;
    expect(await resetJudgePassword({ judgeId: J })).toEqual({ ok: true, password: FIXED });
    expect(log).toEqual(["record:started", "set", "record:success"]);
    expect(h.rdeps).toHaveBeenCalledExactlyOnceWith(session.supabase, session.user.id);
    expect(h.revalidate).toHaveBeenCalledWith("/admin/judges");
  });
});
