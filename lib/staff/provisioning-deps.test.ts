import { beforeEach, describe, expect, it, vi } from "vitest";

// The Supabase-backed dependencies of lib/staff/provisioning.ts, run against a recording stand-in for the Auth admin API and the administrator's
// session, so the exact calls the Rio Admin "Add judge" and "Reset password" flows make are visible. Nothing here reaches Supabase.
// It shows how Rio Admin creation differs from creating a user by hand in the Supabase dashboard: the dashboard sets no first-login mark, Rio Admin does.

const h = vi.hoisted(() => ({
  calls: [] as string[],
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  updateUserById: vi.fn(),
  getUserById: vi.fn(),
  rpc: vi.fn(),
  rows: [] as { table: string; op: string; value?: unknown }[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: { admin: { createUser: h.createUser, deleteUser: h.deleteUser, updateUserById: h.updateUserById, getUserById: h.getUserById } },
    rpc: h.rpc,
  }),
  secretKeyStatus: () => "ok",
}));

const ID = "11111111-1111-4111-8111-111111111111";
const ADMIN = "ad000000-0000-4000-8000-0000000000ad";
const FIXED = "Kd7m-Qp3x-Wn8c-Rt5v-Hj2f";

/** A session stand-in that records inserts, updates and deletes per table. */
function session() {
  const chain = (table: string, op: string, value?: unknown) => {
    h.rows.push({ table, op, value });
    const r = { data: op === "update" ? [{ user_id: ID }] : null, error: null };
    const b: Record<string, unknown> = { eq: () => b, select: () => b, then: (ok: (v: unknown) => unknown) => Promise.resolve(r).then(ok) };
    return b;
  };
  return {
    from: (table: string) => ({
      insert: (v: unknown) => chain(table, "insert", v),
      update: (v: unknown) => chain(table, "update", v),
      delete: () => chain(table, "delete"),
      select: () => chain(table, "select"),
    }),
  } as never;
}

beforeEach(() => {
  h.rows = [];
  for (const m of [h.createUser, h.deleteUser, h.updateUserById, h.getUserById, h.rpc]) m.mockReset();
  h.deleteUser.mockResolvedValue({ error: null });
});

describe("Add judge (createProvisionDeps)", () => {
  it("creates a confirmed account carrying the first-login mark in app_metadata, with the generated password, and nothing else", async () => {
    h.createUser.mockResolvedValue({ data: { user: { id: ID, app_metadata: { must_change_password: true } } }, error: null });
    const { createProvisionDeps } = await import("./provisioning");
    expect(await createProvisionDeps(session()).createUser("new.judge@example.test", FIXED)).toEqual({ userId: ID });
    expect(h.createUser).toHaveBeenCalledExactlyOnceWith({ email: "new.judge@example.test", password: FIXED, email_confirm: true, app_metadata: { must_change_password: true } });
    expect(h.createUser.mock.calls[0]![0]).not.toHaveProperty("user_metadata"); // the mark is never in the user-editable part
    expect(h.deleteUser).not.toHaveBeenCalled();
  });

  it("does not trust a creation that did not save the mark: the account is removed again and nothing usable is left", async () => {
    const { createProvisionDeps } = await import("./provisioning");
    for (const app_metadata of [{}, { must_change_password: false }, { must_change_password: "true" }, undefined]) {
      h.deleteUser.mockClear();
      h.createUser.mockResolvedValue({ data: { user: { id: ID, app_metadata } }, error: null });
      expect(await createProvisionDeps(session()).createUser("a@example.test", FIXED)).toEqual({ error: "failed" });
      expect(h.deleteUser).toHaveBeenCalledExactlyOnceWith(ID);
    }
  });

  it("maps duplicates, rate limits and failures without exposing Supabase's text", async () => {
    const { createProvisionDeps } = await import("./provisioning");
    const cases: [object, string][] = [
      [{ code: "email_exists", status: 422, message: "A user with this email address has already been registered" }, "exists"],
      [{ code: "user_already_exists", status: 422, message: "x" }, "exists"],
      [{ status: 429, message: "slow down" }, "rateLimited"],
      [{ status: 500, message: "boom with details" }, "failed"],
    ];
    for (const [error, expected] of cases) {
      h.createUser.mockResolvedValue({ data: { user: null }, error });
      expect(await createProvisionDeps(session()).createUser("a@example.test", FIXED)).toEqual({ error: expected });
    }
    expect(h.deleteUser).not.toHaveBeenCalled(); // a duplicate never deletes the EXISTING account
  });

  it("a whole successful creation, end to end over the stand-ins: user with mark, role, profile OFF, then switched on last", async () => {
    h.createUser.mockResolvedValue({ data: { user: { id: ID, app_metadata: { must_change_password: true } } }, error: null });
    const { createProvisionDeps, provisionJudgeFlow } = await import("./provisioning");
    const deps = { ...createProvisionDeps(session()), generate: () => FIXED };
    expect(await provisionJudgeFlow(deps, { email: "new.judge@example.test", displayName: "New Judge", emailVerified: true })).toEqual({ ok: true, email: "new.judge@example.test", password: FIXED });
    expect(h.rows).toEqual([
      { table: "user_roles", op: "insert", value: { user_id: ID, role: "judge" } },
      { table: "judge_profiles", op: "insert", value: { user_id: ID, display_name: "New Judge", active: false } },
      { table: "judge_profiles", op: "update", value: { active: true } },
    ]);
    expect(h.deleteUser).not.toHaveBeenCalled();
  });

  it("a creation whose mark was not saved ends with no role, no profile and no account", async () => {
    h.createUser.mockResolvedValue({ data: { user: { id: ID, app_metadata: {} } }, error: null });
    const { createProvisionDeps, provisionJudgeFlow } = await import("./provisioning");
    const deps = { ...createProvisionDeps(session()), generate: () => FIXED };
    expect(await provisionJudgeFlow(deps, { email: "new.judge@example.test", displayName: "New Judge", emailVerified: true })).toEqual({ ok: false, code: "createFailed" });
    expect(h.rows).toEqual([]);
  });
});

describe("Reset password (createResetDeps)", () => {
  it("sets and confirms the mark FIRST, then changes the password in a separate call, so no known password ever exists without the mark", async () => {
    h.updateUserById.mockResolvedValue({ data: { user: { id: ID, app_metadata: { must_change_password: true } } }, error: null });
    const { createResetDeps } = await import("./provisioning");
    expect(await createResetDeps(session(), ADMIN).setPassword(ID, FIXED)).toBe(true);
    expect(h.updateUserById.mock.calls).toEqual([
      [ID, { app_metadata: { must_change_password: true } }],
      [ID, { password: FIXED }],
    ]);
  });

  it("changes nothing if the mark could not be saved or confirmed", async () => {
    const { createResetDeps } = await import("./provisioning");
    h.updateUserById.mockResolvedValue({ data: { user: { id: ID, app_metadata: {} } }, error: null });
    expect(await createResetDeps(session(), ADMIN).setPassword(ID, FIXED)).toBe(false);
    h.updateUserById.mockReset().mockResolvedValue({ data: { user: null }, error: { message: "boom" } });
    expect(await createResetDeps(session(), ADMIN).setPassword(ID, FIXED)).toBe(false);
    for (const call of h.updateUserById.mock.calls) expect(call[1]).not.toHaveProperty("password");
  });

  it("reports failure when the password change itself is refused (the judge stays marked)", async () => {
    h.updateUserById
      .mockResolvedValueOnce({ data: { user: { id: ID, app_metadata: { must_change_password: true } } }, error: null })
      .mockResolvedValueOnce({ data: { user: null }, error: { message: "weak" } });
    const { createResetDeps } = await import("./provisioning");
    expect(await createResetDeps(session(), ADMIN).setPassword(ID, FIXED)).toBe(false);
  });

  it("writes the audit rows through the service-role function with the acting administrator and never a password", async () => {
    h.rpc.mockResolvedValue({ error: null });
    const { createResetDeps } = await import("./provisioning");
    const deps = createResetDeps(session(), ADMIN);
    expect(await deps.record(ID, "started")).toBe(true);
    h.rpc.mockResolvedValueOnce({ error: { code: "42501" } });
    expect(await deps.record(ID, "success")).toBe(false);
    expect(h.rpc.mock.calls[0]).toEqual(["record_judge_password_reset", { p_actor: ADMIN, p_judge: ID, p_outcome: "started" }]);
    expect(JSON.stringify(h.rpc.mock.calls)).not.toMatch(/password"|secret|@/i);
  });

  it("only an existing judge profile counts as a judge (read with the administrator's own session)", async () => {
    const { createResetDeps } = await import("./provisioning");
    const found = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { user_id: ID }, error: null }) }) }) }) } as never;
    const missing = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) } as never;
    expect(await createResetDeps(found, ADMIN).isJudge(ID)).toBe(true);
    expect(await createResetDeps(missing, ADMIN).isJudge(ID)).toBe(false);
  });
});

describe("no password reaches a log", () => {
  it("none of the dependency calls writes to the console, including on failure", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    h.createUser.mockResolvedValue({ data: { user: null }, error: { status: 500, message: "boom" } });
    h.updateUserById.mockRejectedValue(new Error("boom"));
    const { createProvisionDeps, createResetDeps } = await import("./provisioning");
    await createProvisionDeps(session()).createUser("a@example.test", FIXED);
    await createResetDeps(session(), ADMIN).setPassword(ID, FIXED).catch(() => false);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    spies.forEach((s) => s.mockRestore());
  });
});
