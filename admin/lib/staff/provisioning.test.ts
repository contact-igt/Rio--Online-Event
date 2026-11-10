import { describe, expect, it, vi } from "vitest";
import {
  generatePassword,
  passwordProblems,
  provisionJudgeFlow,
  provisioningReadiness,
  resetJudgePasswordFlow,
  staffProvisioningEnabled,
  type ProvisionDeps,
  type ResetDeps,
} from "./provisioning";

// The manual judge creation and password reset, with every Supabase call replaced by a recorder, so each branch (success, duplicate, failure at
// each step, failed undo) is exercised without any account, e-mail or hosted project. Nothing here touches Supabase.

const GOOD = { email: "new.judge@example.test", displayName: "New Judge", emailVerified: true };
const FIXED = "Kd7m-Qp3x-Wn8c-Rt5v-Hj2f";
const ID = "11111111-1111-4111-8111-111111111111";

type Log = string[];
function deps(log: Log, fail: Partial<Record<"createUser" | "addRole" | "addProfile" | "activate" | "removeProfile" | "removeRole" | "removeUser", "false" | "throw" | "exists" | "rate">> = {}): ProvisionDeps {
  const step = (name: keyof typeof fail) => async () => {
    log.push(name);
    if (fail[name] === "throw") throw new Error("boom");
    return fail[name] !== "false";
  };
  return {
    generate: () => FIXED,
    async createUser(email, password) {
      log.push(`createUser:${email}:${password === FIXED ? "generated" : "other"}`);
      if (fail.createUser === "throw") throw new Error("boom");
      if (fail.createUser === "exists") return { error: "exists" };
      if (fail.createUser === "rate") return { error: "rateLimited" };
      if (fail.createUser === "false") return { error: "failed" };
      return { userId: ID };
    },
    addRole: step("addRole"),
    addProfile: async (id, name) => (log.push(`profile:${name}`), step("addProfile")()),
    activate: step("activate"),
    removeProfile: step("removeProfile"),
    removeRole: step("removeRole"),
    removeUser: step("removeUser"),
  };
}

describe("the feature switch", () => {
  it("is on only for exactly yes, and is separate from the invitations switch", () => {
    expect(staffProvisioningEnabled({ RIO_STAFF_PROVISIONING_ENABLED: "yes" })).toBe(true);
    for (const v of [undefined, "", "no", "YES", "Yes", "true", "1", " yes", "yes "]) expect(staffProvisioningEnabled({ RIO_STAFF_PROVISIONING_ENABLED: v })).toBe(false);
    expect(staffProvisioningEnabled({ RIO_STAFF_INVITES_ENABLED: "yes" })).toBe(false);
    expect(staffProvisioningEnabled({})).toBe(false);
  });

  it("is ready only with the switch AND a well-formed secret key", () => {
    const key = "sb_secret_abcdefghijklmnop";
    expect(provisioningReadiness({ RIO_STAFF_PROVISIONING_ENABLED: "yes", SUPABASE_SECRET_KEY: key }).ready).toBe(true);
    expect(provisioningReadiness({ RIO_STAFF_PROVISIONING_ENABLED: "yes" })).toMatchObject({ enabled: true, secretKey: "missing", ready: false });
    expect(provisioningReadiness({ SUPABASE_SECRET_KEY: key })).toMatchObject({ enabled: false, ready: false });
  });
});

describe("generatePassword", () => {
  it("makes long, readable, varied passwords that pass the rules", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const p = generatePassword();
      seen.add(p);
      expect(p).toMatch(/^[A-Za-z2-9]{4}(-[A-Za-z2-9]{4}){4}$/); // 20 characters in five groups, no look-alikes (0 O 1 l I)
      expect(p.length).toBeGreaterThanOrEqual(12);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[0-9]/);
      expect(passwordProblems(p, "judge@example.test")).toEqual([]);
    }
    expect(seen.size).toBe(300); // never a fixed or repeating password
  });

  it("uses all kinds of characters across many passwords, not a fixed pattern", () => {
    const joined = Array.from({ length: 200 }, generatePassword).join("");
    expect(new Set(joined.replace(/-/g, "")).size).toBeGreaterThan(40);
  });
});

describe("passwordProblems", () => {
  it("refuses short, common, repetitive and email-derived passwords, with fixed labels that never contain the password", () => {
    expect(passwordProblems("123", "a@b.test")).toContain("shorter than 12 characters");
    expect(passwordProblems("password123", "a@b.test").length).toBeGreaterThan(0);
    expect(passwordProblems("aaaaaaaaaaaaaaaa", "a@b.test")).toContain("too few different characters");
    expect(passwordProblems("xxjudgenamexx99", "judgename@example.test")).toContain("contains the email name");
    expect(passwordProblems(" Kd7mQp3xWn8c ", "a@b.test")).toContain("starts or ends with a space");
    for (const label of passwordProblems("123", "a@b.test")) expect(label).not.toContain("123");
  });
});

describe("provisionJudgeFlow", () => {
  it("creates the account, records the role, adds the profile switched OFF, then switches it on last, and returns the password once", async () => {
    const log: Log = [];
    const result = await provisionJudgeFlow(deps(log), GOOD);
    expect(result).toEqual({ ok: true, email: "new.judge@example.test", password: FIXED });
    expect(log).toEqual(["createUser:new.judge@example.test:generated", "addRole", "profile:New Judge", "addProfile", "activate"]);
  });

  it("normalises the e-mail and the display name before anything is created", async () => {
    const log: Log = [];
    await provisionJudgeFlow(deps(log), { email: "  New.Judge@Example.TEST ", displayName: "  New \n  Judge ", emailVerified: true });
    expect(log[0]).toBe("createUser:new.judge@example.test:generated");
    expect(log).toContain("profile:New Judge");
  });

  it("refuses invalid input without calling Supabase", async () => {
    for (const bad of [
      { email: "nope", displayName: "X", emailVerified: true },
      { email: "a@b.test", displayName: "", emailVerified: true },
      { email: "a@b.test", displayName: "   ", emailVerified: true },
      { email: "a@b.test", displayName: "x".repeat(81), emailVerified: true },
      { email: 5, displayName: "X", emailVerified: true },
      { email: "a@b.test", displayName: {}, emailVerified: true },
    ]) {
      const log: Log = [];
      expect(await provisionJudgeFlow(deps(log), bad as never)).toEqual({ ok: false, code: "invalid" });
      expect(log).toEqual([]);
    }
  });

  it("will not mark an e-mail confirmed unless the administrator vouched for it", async () => {
    for (const v of [undefined, false, "on", "true", 1]) {
      const log: Log = [];
      expect(await provisionJudgeFlow(deps(log), { ...GOOD, emailVerified: v })).toEqual({ ok: false, code: "emailNotConfirmed" });
      expect(log).toEqual([]);
    }
  });

  it("rejects a duplicate account safely: nothing else is created or removed, and the answer does not say what the existing account is", async () => {
    const log: Log = [];
    const result = await provisionJudgeFlow(deps(log, { createUser: "exists" }), GOOD);
    expect(result).toEqual({ ok: false, code: "duplicate" });
    expect(log).toEqual(["createUser:new.judge@example.test:generated"]); // no role, no profile, and above all no removeUser of the EXISTING account
  });

  it("maps a rate limit and a failure to create to their own answers, with nothing left behind", async () => {
    expect(await provisionJudgeFlow(deps([], { createUser: "rate" }), GOOD)).toEqual({ ok: false, code: "tooMany" });
    expect(await provisionJudgeFlow(deps([], { createUser: "false" }), GOOD)).toEqual({ ok: false, code: "createFailed" });
    const log: Log = [];
    expect(await provisionJudgeFlow(deps(log, { createUser: "throw" }), GOOD)).toEqual({ ok: false, code: "createFailed" });
    expect(log).toEqual(["createUser:new.judge@example.test:generated"]);
  });

  it.each([
    ["addRole", ["addRole", "removeUser"]],
    ["addProfile", ["addRole", "profile:New Judge", "addProfile", "removeRole", "removeUser"]],
    ["activate", ["addRole", "profile:New Judge", "addProfile", "activate", "removeProfile", "removeRole", "removeUser"]],
  ] as const)("rolls everything back, newest first, when %s fails (returned false or threw)", async (failing, expected) => {
    for (const mode of ["false", "throw"] as const) {
      const log: Log = [];
      const result = await provisionJudgeFlow(deps(log, { [failing]: mode }), GOOD);
      expect(result).toEqual({ ok: false, code: "provisionFailed" });
      expect(log.slice(1)).toEqual(expected);
      expect(result).not.toHaveProperty("password"); // a failed creation never reveals a password
    }
  });

  it("keeps undoing when one undo fails, and reports a partial result without a password", async () => {
    const log: Log = [];
    const result = await provisionJudgeFlow(deps(log, { activate: "false", removeProfile: "throw" }), GOOD);
    expect(result).toEqual({ ok: false, code: "partial" });
    expect(log.slice(-3)).toEqual(["removeProfile", "removeRole", "removeUser"]);
    expect(await provisionJudgeFlow(deps([], { addRole: "false", removeUser: "false" }), GOOD)).toEqual({ ok: false, code: "partial" });
  });

  it("never leaks the password in an error result", async () => {
    for (const fail of ["addRole", "addProfile", "activate"] as const) {
      const result = await provisionJudgeFlow(deps([], { [fail]: "throw", removeUser: "throw" }), GOOD);
      expect(JSON.stringify(result)).not.toContain(FIXED);
    }
  });

  it("generates a fresh password for each account and regenerates one that breaks a rule", async () => {
    const seen: string[] = [];
    const sequence = ["short", "judgeone-aaaa-BBBB-cccc", FIXED];
    const d = deps([]);
    d.generate = () => sequence.shift() ?? "unused";
    d.createUser = async (_e, p) => (seen.push(p), { userId: ID });
    const result = await provisionJudgeFlow(d, { email: "judgeone@example.test", displayName: "J", emailVerified: true });
    expect(seen).toEqual([FIXED]); // the first two broke the rules and never reached Supabase
    expect(result).toMatchObject({ ok: true, password: FIXED });
  });

  it("gives up (and creates nothing) if the generator keeps producing unusable passwords", async () => {
    const d = deps([]);
    d.generate = () => "short";
    expect(await provisionJudgeFlow(d, GOOD)).toEqual({ ok: false, code: "createFailed" });
  });
});

describe("resetJudgePasswordFlow", () => {
  function reset(log: Log, o: { judge?: boolean; record?: boolean | "throw"; set?: boolean | "throw"; email?: string | null } = {}): ResetDeps {
    return {
      generate: () => FIXED,
      isJudge: async (id) => (log.push(`judge?:${id}`), o.judge !== false),
      email: async () => (o.email === undefined ? "judge.one@example.test" : o.email),
      record: async (id, outcome) => {
        log.push(`record:${outcome}:${id}`);
        if (o.record === "throw") throw new Error("boom");
        return o.record !== false;
      },
      setPassword: async (id, p) => {
        log.push(`set:${id}:${p === FIXED ? "generated" : "other"}`);
        if (o.set === "throw") throw new Error("boom");
        return o.set !== false;
      },
    };
  }

  it("records STARTED first, sets a new generated password, records SUCCESS, and returns the password once", async () => {
    const log: Log = [];
    expect(await resetJudgePasswordFlow(reset(log), { judgeId: ID })).toEqual({ ok: true, password: FIXED });
    expect(log).toEqual([`judge?:${ID}`, `record:started:${ID}`, `set:${ID}:generated`, `record:success:${ID}`]);
  });

  it("refuses anything that is not a judge profile (an administrator, a parent, an unknown id) and writes nothing", async () => {
    const log: Log = [];
    expect(await resetJudgePasswordFlow(reset(log, { judge: false }), { judgeId: ID })).toEqual({ ok: false, code: "notFound" });
    expect(log).toEqual([`judge?:${ID}`]);
  });

  it("refuses a malformed id without calling anything", async () => {
    for (const bad of ["", "abc", 5, null, undefined, "11111111-1111-1111-1111-11111111111"]) {
      const log: Log = [];
      expect(await resetJudgePasswordFlow(reset(log), { judgeId: bad })).toEqual({ ok: false, code: "invalid" });
      expect(log).toEqual([]);
    }
  });

  it("changes nothing if the STARTED row cannot be written (returned false or threw)", async () => {
    for (const record of [false, "throw"] as const) {
      const log: Log = [];
      expect(await resetJudgePasswordFlow(reset(log, { record }), { judgeId: ID })).toEqual({ ok: false, code: "unavailable" });
      expect(log.some((l) => l.startsWith("set:"))).toBe(false);
    }
  });

  it("records FAILED and says the old password still works when the new one could not be set, with no password in the answer", async () => {
    for (const set of [false, "throw"] as const) {
      const log: Log = [];
      const result = await resetJudgePasswordFlow(reset(log, { set }), { judgeId: ID });
      expect(result).toEqual({ ok: false, code: "unavailable" });
      expect(log.slice(-1)).toEqual([`record:failed:${ID}`]);
      expect(JSON.stringify(result)).not.toContain(FIXED);
    }
  });

  it("still returns the new password when only the closing audit row could not be written (the reset happened; STARTED remains as evidence)", async () => {
    const log: Log = [];
    const d = reset(log);
    let calls = 0;
    d.record = async (id, outcome) => {
      log.push(`record:${outcome}:${id}`);
      return ++calls === 1; // STARTED is written, the closing row is not
    };
    expect(await resetJudgePasswordFlow(d, { judgeId: ID })).toEqual({ ok: true, password: FIXED });
  });
});

describe("no password or secret reaches a log", () => {
  it("creating and resetting write nothing to the console, whatever happens", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const log: Log = [];
    await provisionJudgeFlow(deps(log), GOOD);
    await provisionJudgeFlow(deps([], { addProfile: "throw", removeRole: "throw" }), GOOD);
    await provisionJudgeFlow(deps([], { createUser: "throw" }), GOOD);
    const r: ResetDeps = {
      generate: () => FIXED,
      isJudge: async () => true,
      email: async () => "a@example.test",
      record: async () => true,
      setPassword: async () => {
        throw new Error("boom");
      },
    };
    await resetJudgePasswordFlow(r, { judgeId: ID });
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    spies.forEach((s) => s.mockRestore());
  });
});
