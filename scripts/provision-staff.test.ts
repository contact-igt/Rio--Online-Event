import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertProvisionTarget, parseArgs, passwordProblems, provision, type ProvisionDeps, type Role } from "./provision-staff";
import { GuardError } from "./live-target";

const GOOD_PASSWORD = "Tr0ub4dor&3-horse-staple";

function fakeDeps(initial: { user?: { id: string; role?: Role | null; profile?: boolean } | null } = {}) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const state = { user: initial.user ? { ...initial.user } : null };
  const deps: ProvisionDeps = {
    findUser: async () => (state.user ? { id: state.user.id } : null),
    createUser: async (email, pw) => {
      calls.push({ fn: "createUser", args: [email, pw] });
      state.user = { id: "new-id", role: null, profile: false };
      return { id: "new-id" };
    },
    setPassword: async (id, pw) => void calls.push({ fn: "setPassword", args: [id, pw] }),
    roleOf: async () => state.user?.role ?? null,
    addRole: async (id, role) => {
      calls.push({ fn: "addRole", args: [id, role] });
      state.user!.role = role;
    },
    hasProfile: async () => state.user?.profile === true,
    addProfile: async (id, name) => {
      calls.push({ fn: "addProfile", args: [id, name] });
      state.user!.profile = true;
    },
  };
  return { deps, calls };
}
const admin = { role: "admin", email: "admin@example.org", name: null, resetPassword: false } as const;
const judge = { role: "judge", email: "judge@example.org", name: "Judge One", resetPassword: false } as const;

describe("parseArgs", () => {
  it("reads a role, an email and (for judges) a name", () => {
    expect(parseArgs(["--role", "admin", "--email", " Admin@Example.org "])).toEqual({ role: "admin", email: "admin@example.org", name: null, resetPassword: false });
    expect(parseArgs(["--role", "judge", "--email", "j@example.org", "--name", "Judge One", "--reset-password"])).toEqual({ role: "judge", email: "j@example.org", name: "Judge One", resetPassword: true });
  });
  it("refuses a missing or odd role, a bad email, a judge without a name, an admin with one", () => {
    for (const argv of [[], ["--role", "owner", "--email", "a@b.co"], ["--role", "admin"], ["--role", "admin", "--email", "nope"], ["--role", "judge", "--email", "j@example.org"], ["--role", "judge", "--email", "j@example.org", "--name", "x".repeat(81)], ["--role", "admin", "--email", "a@example.org", "--name", "Nope"]]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(GuardError);
    }
  });
  it("refuses a password on the command line, however it is spelled", () => {
    for (const flag of ["--password", "--pass", "--pw"]) expect(() => parseArgs(["--role", "admin", "--email", "a@example.org", flag, "hunter2hunter2"])).toThrow(/never given on the command line/);
  });
});

describe("passwordProblems", () => {
  it("accepts a long, varied password", () => expect(passwordProblems(GOOD_PASSWORD, "admin@example.org")).toEqual([]));
  it("names what is wrong, never the password", () => {
    expect(passwordProblems("short", "a@example.org")).toContain("shorter than 12 characters");
    expect(passwordProblems("aaaaaaaaaaaaaaaa", "a@example.org")).toContain("too few different characters");
    expect(passwordProblems("xxadminxx-and-more-1", "admin@example.org")).toContain("contains the email name");
    expect(passwordProblems("Password123", "a@example.org").length).toBeGreaterThan(0);
    expect(passwordProblems("password123", "a@example.org")).toContain("shorter than 12 characters");
    expect(passwordProblems(" leading-space-1234", "a@example.org")).toContain("starts or ends with a space");
    expect(passwordProblems("x".repeat(129), "a@example.org")).toContain("longer than 128 characters");
    expect(JSON.stringify(passwordProblems("short", "a@example.org"))).not.toContain("short\"");
  });
});

describe("assertProvisionTarget", () => {
  const REF = "abcdefghijklmnopqrst";
  const env = { RIO_LIVE_URL: `https://${REF}.supabase.co`, RIO_LIVE_PUBLISHABLE_KEY: "sb_publishable_x", RIO_LIVE_SECRET_KEY: "sb_secret_x", RIO_DEV_PROJECT_REF: REF, RIO_LIVE_CONFIRM: REF, RIO_CONFIRM_PROVISION: REF };
  it("accepts the dev project with both typed confirmations", () => expect(assertProvisionTarget(env, "zzzzzzzzzzzzzzzzzzzz", "sb_publishable_prod")).toEqual({ ref: REF }));
  it("refuses a missing or wrong provisioning confirmation", () => {
    for (const v of [undefined, "", "yes", "zzzzzzzzzzzzzzzzzzzz"]) expect(() => assertProvisionTarget({ ...env, RIO_CONFIRM_PROVISION: v }, null, null), String(v)).toThrow(GuardError);
  });
  it("refuses the production project, a local stack, and a missing live confirmation", () => {
    expect(() => assertProvisionTarget(env, REF, null)).toThrow(GuardError);
    expect(() => assertProvisionTarget({ ...env, RIO_LIVE_URL: "http://127.0.0.1:54321", RIO_CONFIRM_PROVISION: "local" }, null, null)).toThrow(GuardError);
    expect(() => assertProvisionTarget({ ...env, RIO_LIVE_CONFIRM: undefined }, null, null)).toThrow(GuardError);
  });
});

describe("provision", () => {
  it("creates a new administrator account with the password given to Supabase Auth only, and adds the role", async () => {
    const { deps, calls } = fakeDeps();
    const summary = await provision(deps, admin, GOOD_PASSWORD);
    expect(summary).toEqual({ createdAccount: true, passwordSet: true, roleAdded: true, profileAdded: false });
    expect(calls.map((c) => c.fn)).toEqual(["createUser", "addRole"]);
    expect(JSON.stringify(summary)).not.toContain(GOOD_PASSWORD);
    // the password appears in exactly one call: createUser
    expect(calls.filter((c) => JSON.stringify(c.args).includes(GOOD_PASSWORD)).map((c) => c.fn)).toEqual(["createUser"]);
  });
  it("creates a judge with a role and a display-name profile", async () => {
    const { deps, calls } = fakeDeps();
    expect(await provision(deps, judge, GOOD_PASSWORD)).toEqual({ createdAccount: true, passwordSet: true, roleAdded: true, profileAdded: true });
    expect(calls.map((c) => c.fn)).toEqual(["createUser", "addRole", "addProfile"]);
  });
  it("refuses a weak password before anything is created", async () => {
    const { deps, calls } = fakeDeps();
    await expect(provision(deps, admin, "short")).rejects.toThrow(GuardError);
    await expect(provision(deps, admin, null)).rejects.toThrow(GuardError);
    expect(calls).toEqual([]);
  });
  it("a refusal names the broken rules but never contains the password", async () => {
    const weak = "adminadmin";
    const error = await provision(fakeDeps().deps, admin, weak).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/shorter than 12 characters; contains the email name/);
    expect((error as Error).message).not.toContain(weak);
  });
  it("an existing account keeps its password unless --reset-password is given; the role is added once", async () => {
    const a = fakeDeps({ user: { id: "u1", role: null } });
    expect(await provision(a.deps, admin, null)).toEqual({ createdAccount: false, passwordSet: false, roleAdded: true, profileAdded: false });
    expect(a.calls.map((c) => c.fn)).toEqual(["addRole"]);
    const b = fakeDeps({ user: { id: "u1", role: "admin" } });
    expect(await provision(b.deps, admin, null)).toEqual({ createdAccount: false, passwordSet: false, roleAdded: false, profileAdded: false });
    expect(b.calls).toEqual([]);
  });
  it("--reset-password sets a new password for an existing account, with the same rules", async () => {
    const { deps, calls } = fakeDeps({ user: { id: "u1", role: "admin" } });
    expect(await provision(deps, { ...admin, resetPassword: true }, GOOD_PASSWORD)).toMatchObject({ passwordSet: true, createdAccount: false });
    expect(calls.map((c) => c.fn)).toEqual(["setPassword"]);
    await expect(provision(deps, { ...admin, resetPassword: true }, "short")).rejects.toThrow(GuardError);
    await expect(provision(deps, { ...admin, resetPassword: true }, null)).rejects.toThrow(GuardError);
  });
  it("never changes the role of an account that already has a different one", async () => {
    const { deps, calls } = fakeDeps({ user: { id: "u1", role: "judge", profile: true } });
    await expect(provision(deps, admin, GOOD_PASSWORD)).rejects.toThrow(/different staff role/);
    expect(calls).toEqual([]);
  });
  it("is safe to repeat for a judge: no second role or profile", async () => {
    const { deps, calls } = fakeDeps({ user: { id: "u1", role: "judge", profile: true } });
    expect(await provision(deps, judge, null)).toEqual({ createdAccount: false, passwordSet: false, roleAdded: false, profileAdded: false });
    expect(calls).toEqual([]);
  });
});

describe("the script's source", () => {
  const source = readFileSync(new URL("./provision-staff.ts", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  it("contains no password literal and never prints the password or the secret key", () => {
    expect(source).not.toMatch(/password\s*[:=]\s*["'`][^"'`]{4,}["'`]/i);
    for (const line of source.split("\n").filter((l) => /console\.(log|error|info|warn)/.test(l))) expect(line, line).not.toMatch(/\$\{\s*(password|pw|process\.env)|RIO_STAFF_PASSWORD|SECRET_KEY|\+\s*(password|pw)\b/i); // the word "password" in a label is fine; the value never is
  });
  it("reads the password only from a hidden prompt or RIO_STAFF_PASSWORD, and writes no file or SQL", () => {
    expect(source).toContain("RIO_STAFF_PASSWORD");
    expect(source).toContain("setRawMode(true)");
    expect(source).not.toMatch(/writeFile|appendFile|createWriteStream|\.rpc\(|\binsert into\b|\.sql/i);
  });
  it("sends the password only to Supabase Auth (createUser and updateUserById)", () => {
    expect(source.match(/auth\.admin\.(createUser|updateUserById)/g)?.length).toBe(2);
  });
});
