import { describe, expect, it, vi } from "vitest";
import { signInErrorCode, staffLogin, type LoginDeps } from "./login";
import type { StaffRole } from "./paths";
import { staffHome, staffLoginPath } from "./paths";

const ID = "aaaaaaaa-0000-4000-8000-00000000000a";
const PASSWORD = "correct-horse-battery-staple-1";

function setup(over: { signIn?: LoginDeps["signIn"]; role?: StaffRole | null | Error } = {}) {
  const signIn = vi.fn(over.signIn ?? (async () => ({ userId: ID })));
  const roleOf = vi.fn(async () => {
    if (over.role instanceof Error) throw over.role;
    return over.role === undefined ? "admin" : over.role;
  });
  const signOut = vi.fn(async () => undefined);
  return { signIn, roleOf, signOut, deps: { signIn, roleOf, signOut } as LoginDeps };
}
const go = (deps: LoginDeps, email: unknown = "admin@example.org", password: unknown = PASSWORD) => staffLogin(deps, { email, password });

describe("staffLogin", () => {
  it("signs in an administrator with the right password and says where to go", async () => {
    const { deps, signOut } = setup({ role: "admin" });
    const res = await go(deps);
    expect(res).toEqual({ ok: true, role: "admin" });
    expect(staffHome("admin")).toBe("/admin");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("signs in an active judge and sends them to the judge area", async () => {
    const { deps } = setup({ role: "judge" });
    expect(await go(deps, "judge@example.org")).toEqual({ ok: true, role: "judge" });
    expect(staffHome("judge")).toBe("/judge");
  });

  it("normalises the email (case, spaces, invisible characters) and passes the password through untouched", async () => {
    const { deps, signIn } = setup();
    await go(deps, "  Admin@Example.ORG​ ", "  keeps spaces and Case 123  ");
    expect(signIn).toHaveBeenCalledExactlyOnceWith("admin@example.org", "  keeps spaces and Case 123  ");
  });

  it("a wrong password is the generic 'credentials' answer, and no role is looked up", async () => {
    const { deps, roleOf } = setup({ signIn: async () => ({ error: "credentials" }) });
    expect(await go(deps)).toEqual({ ok: false, code: "credentials" });
    expect(roleOf).not.toHaveBeenCalled();
  });

  it("a correct password is NOT enough: a parent or any account with no staff role is refused and signed out again", async () => {
    const { deps, signOut } = setup({ role: null });
    expect(await go(deps, "parent@example.org")).toEqual({ ok: false, code: "notStaff" });
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("an inactive judge (the role lookup yields nothing) is refused and signed out", async () => {
    const { deps, signOut } = setup({ role: null });
    expect(await go(deps, "judge@example.org")).toEqual({ ok: false, code: "notStaff" });
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("if the role cannot be read, nobody gets in", async () => {
    const { deps, signOut } = setup({ role: new Error("database down") });
    expect(await go(deps)).toEqual({ ok: false, code: "notStaff" });
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("a failing sign-out still refuses", async () => {
    const { deps } = setup({ role: null });
    deps.signOut = async () => {
      throw new Error("x");
    };
    expect(await go(deps)).toEqual({ ok: false, code: "notStaff" });
  });

  it("malformed input never reaches Supabase", async () => {
    for (const [email, password] of [["", PASSWORD], ["not-an-email", PASSWORD], ["admin@example.org", ""], [undefined, PASSWORD], ["admin@example.org", undefined], [5, 5], ["admin@example.org", "x".repeat(257)], [null, null]] as const) {
      const { deps, signIn } = setup();
      expect(await staffLogin(deps, { email, password }), JSON.stringify([email, typeof password])).toEqual({ ok: false, code: "invalid" });
      expect(signIn).not.toHaveBeenCalled();
    }
    expect(await staffLogin(setup().deps, undefined as never)).toEqual({ ok: false, code: "invalid" });
  });

  it("rate limits and outages are passed on as such, and an exception becomes 'unavailable'", async () => {
    expect(await go(setup({ signIn: async () => ({ error: "tooMany" }) }).deps)).toEqual({ ok: false, code: "tooMany" });
    expect(await go(setup({ signIn: async () => ({ error: "unavailable" }) }).deps)).toEqual({ ok: false, code: "unavailable" });
    expect(await go(setup({ signIn: async () => { throw new Error("network down https://x.supabase.co"); } }).deps)).toEqual({ ok: false, code: "unavailable" });
  });

  it("no result contains the password, the user id or any provider text", async () => {
    const results = [
      await go(setup({ role: "admin" }).deps),
      await go(setup({ role: null }).deps),
      await go(setup({ signIn: async () => ({ error: "credentials" }) }).deps),
      await go(setup({ signIn: async () => { throw new Error(`secret ${PASSWORD}`); } }).deps),
    ];
    const text = JSON.stringify(results);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(ID);
    expect(text).not.toMatch(/secret|supabase|database/i);
  });

  it("the password is only ever given to signIn", async () => {
    const { deps, roleOf, signOut } = setup();
    await go(deps);
    expect(JSON.stringify([roleOf.mock.calls, signOut.mock.calls])).not.toContain(PASSWORD);
  });
});

describe("signInErrorCode", () => {
  it("answers wrong password, unknown email, unconfirmed, banned and 'no password set' identically", () => {
    for (const e of [{ status: 400, code: "invalid_credentials" }, { status: 400, code: "email_not_confirmed" }, { status: 400, code: "user_banned" }, { status: 422 }, { status: 403 }]) expect(signInErrorCode(e), JSON.stringify(e)).toBe("credentials");
  });
  it("separates rate limits and outages", () => {
    expect(signInErrorCode({ status: 429 })).toBe("tooMany");
    expect(signInErrorCode({ code: "over_request_rate_limit" })).toBe("tooMany");
    expect(signInErrorCode({ status: 500 })).toBe("unavailable");
    expect(signInErrorCode({})).toBe("unavailable");
    expect(signInErrorCode(null)).toBe("unavailable");
  });
});

describe("paths", () => {
  it("are fixed strings", () => {
    expect(staffLoginPath).toBe("/staff/login");
    expect(staffHome("admin")).toBe("/admin");
    expect(staffHome("judge")).toBe("/judge");
  });
});
