import { describe, expect, it, vi } from "vitest";
import { setStaffPassword, type SetPasswordDeps } from "./password-setup";

const TOKEN = "abcDEF123_-abcDEF123";
const PASSWORD = "correct horse battery 7";

function deps(over: Partial<SetPasswordDeps> = {}) {
  const calls: string[] = [];
  const d: SetPasswordDeps = {
    verify: async (t, type) => {
      calls.push(`verify:${type}`);
      return { userId: "u1" };
    },
    currentUser: async () => {
      calls.push("current");
      return { userId: "u1" };
    },
    setPassword: async () => {
      calls.push("set");
      return "ok";
    },
    roleOf: async () => "judge",
    signOut: async () => {
      calls.push("signout");
    },
    ...over,
  };
  return { d, calls };
}
const form = (over: Record<string, unknown> = {}) => ({ password: PASSWORD, confirm: PASSWORD, tokenHash: TOKEN, type: "invite", ...over });

describe("setStaffPassword", () => {
  it("checks the one-time token when the form is sent, sets the password, and returns the role", async () => {
    const { d, calls } = deps();
    expect(await setStaffPassword(d, form())).toEqual({ ok: true, role: "judge" });
    expect(calls).toEqual(["verify:invite", "set"]);
  });

  it("refuses short, unequal and malformed input before Supabase is asked anything", async () => {
    for (const [over, code] of [[{ password: "short", confirm: "short" }, "invalid"], [{ confirm: "different password 1" }, "mismatch"], [{ tokenHash: "bad token!" }, "invalid"], [{ type: "magiclink" }, "invalid"], [{ type: undefined }, "invalid"], [{ password: 12345678901234, confirm: 1 }, "invalid"]] as const) {
      const { d, calls } = deps();
      expect(await setStaffPassword(d, form(over)), JSON.stringify(over)).toEqual({ ok: false, code });
      expect(calls).toEqual([]);
    }
  });

  it("an expired or used link sets nothing", async () => {
    const { d, calls } = deps({ verify: async () => ({ error: "link" }) });
    expect(await setStaffPassword(d, form())).toEqual({ ok: false, code: "linkInvalid" });
    expect(calls).toEqual([]);
  });

  it("a signed-in person with NO staff role is signed out and refused, and no password is set (a parent can never use this page)", async () => {
    const { d, calls } = deps({ roleOf: async () => null });
    expect(await setStaffPassword(d, form())).toEqual({ ok: false, code: "notStaff" });
    expect(calls).toEqual(["verify:invite", "signout"]);
  });

  it("a weak password keeps the person signed in and continues in session mode, where no token is needed", async () => {
    const { d } = deps({ setPassword: async () => "weak" });
    expect(await setStaffPassword(d, form())).toEqual({ ok: false, code: "weak", session: true });
    const second = deps();
    expect(await setStaffPassword(second.d, form({ tokenHash: undefined, type: undefined }))).toEqual({ ok: true, role: "judge" });
    expect(second.calls).toEqual(["current", "set"]); // the signed-in staff member only, never a token
  });

  it("session mode without a signed-in person is refused, and a role-less one is signed out", async () => {
    expect(await setStaffPassword(deps({ currentUser: async () => null }).d, form({ tokenHash: undefined, type: undefined }))).toEqual({ ok: false, code: "linkInvalid" });
    const { d, calls } = deps({ roleOf: async () => null });
    expect(await setStaffPassword(d, form({ tokenHash: undefined, type: undefined }))).toEqual({ ok: false, code: "notStaff" });
    expect(calls).toContain("signout");
  });

  it("a token without a type (or the reverse) is invalid", async () => {
    expect((await setStaffPassword(deps().d, form({ type: undefined }))).ok).toBe(false);
    expect((await setStaffPassword(deps().d, form({ tokenHash: undefined }))).ok).toBe(false);
  });

  it("a thrown error is a plain 'unavailable' and the password appears in no result", async () => {
    const { d } = deps({ verify: async () => { throw new Error(`boom ${PASSWORD}`); } });
    const result = await setStaffPassword(d, form());
    expect(result).toEqual({ ok: false, code: "unavailable" });
    for (const r of [result, await setStaffPassword(deps().d, form())]) expect(JSON.stringify(r)).not.toContain(PASSWORD);
    const log = vi.spyOn(console, "error");
    await setStaffPassword(d, form());
    expect(log).not.toHaveBeenCalled();
  });
});
