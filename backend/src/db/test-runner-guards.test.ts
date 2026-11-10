import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GuardError } from "./guards.ts";
import { assertMayDrop, assertNotApplicationAccount, DISPOSABLE_NAME, newDisposableName, parseTestServerUrl, testDatabaseUrl } from "./test-runner-guards.ts";

const good = "mysql://rio_tester:Tester-Pass-123@127.0.0.1:3306";
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GuardError);
    return (e as Error).message;
  }
  throw new Error("expected a GuardError");
};

describe("the test account", () => {
  it("accepts a dedicated local account with a password and no database in the URL", () => {
    expect(parseTestServerUrl(good)).toEqual({ host: "127.0.0.1", port: 3306, user: "rio_tester", password: "Tester-Pass-123" });
    expect(parseTestServerUrl("mysql://rio_tester:p%40ss@localhost:3307/")).toMatchObject({ host: "localhost", port: 3307, password: "p@ss" });
  });

  it.each([
    ["root", "mysql://root:secret-pw-1@127.0.0.1:3306"],
    ["ROOT in capitals", "mysql://ROOT:secret-pw-1@127.0.0.1:3306"],
    ["the application account rio_app", "mysql://rio_app:secret-pw-1@127.0.0.1:3306"],
    ["the phpMyAdmin account", "mysql://pma:secret-pw-1@127.0.0.1:3306"],
    ["a system account", "mysql://mariadb.sys:secret-pw-1@127.0.0.1:3306"],
    ["no user at all", "mysql://:secret-pw-1@127.0.0.1:3306"],
    ["an account without a password", "mysql://rio_tester@127.0.0.1:3306"],
    ["an empty password", "mysql://rio_tester:@127.0.0.1:3306"],
    ["a database in the URL (rio_hospital)", "mysql://rio_tester:secret-pw-1@127.0.0.1:3306/rio_hospital"],
    ["any database in the URL", "mysql://rio_tester:secret-pw-1@127.0.0.1:3306/scratch_test"],
    ["a remote host", "mysql://rio_tester:secret-pw-1@db.example.org:3306"],
    ["a LAN address", "mysql://rio_tester:secret-pw-1@192.168.31.98:3306"],
    ["the wrong protocol", "postgres://rio_tester:secret-pw-1@127.0.0.1:3306"],
    ["a query string", "mysql://rio_tester:secret-pw-1@127.0.0.1:3306?ssl=false"],
    ["not a URL", "rio_tester:secret-pw-1@127.0.0.1"],
  ])("refuses %s, and the message contains no password, user or host", (_label, url) => {
    const message = refusal(() => parseTestServerUrl(url));
    expect(message).not.toMatch(/secret-pw|rio_tester|db\.example|192\.168|rio_app|root:/);
  });

  it("refuses an account that is the application's own, whatever the case", () => {
    const server = parseTestServerUrl(good);
    expect(refusal(() => assertNotApplicationAccount(server, "mysql://RIO_TESTER:other-pw-1@127.0.0.1:3306/rio_hospital"))).toContain("same account");
    expect(() => assertNotApplicationAccount(server, "mysql://rio_app:other-pw-1@127.0.0.1:3306/rio_hospital")).not.toThrow();
    expect(() => assertNotApplicationAccount(server, undefined)).not.toThrow();
    expect(() => assertNotApplicationAccount(server, "not a url")).not.toThrow();
  });

  it("builds the test URL for exactly one database, encoding special characters", () => {
    const server = parseTestServerUrl("mysql://rio_tester:p%40ss%2Fword@127.0.0.1:3306");
    const url = new URL(testDatabaseUrl(server, "rio_0123456789ab_test"));
    expect(url.pathname).toBe("/rio_0123456789ab_test");
    expect(decodeURIComponent(url.password)).toBe("p@ss/word");
  });
});

describe("the disposable database name", () => {
  it("is always rio_<12 hex>_test, different every time, and never a database that already matters", () => {
    const names = new Set(Array.from({ length: 300 }, newDisposableName));
    expect(names.size).toBe(300);
    for (const n of names) {
      expect(n).toMatch(DISPOSABLE_NAME);
      expect(n).not.toBe("rio_hospital");
      expect(n.endsWith("_test")).toBe(true); // the rule the test configuration itself enforces
    }
  });

  it.each(["rio_hospital", "rio_test", "rio_scratch_test", "mysql", "information_schema", "test", "", "rio_0123456789ab", "rio_0123456789AB_test", "rio_0123456789abc_test", "rio_0123456789ab_test;", "rio_0123456789ab_test`", "xrio_0123456789ab_test", "rio_0123456789ab_testx"])(
    "does not match %j",
    (name) => {
      expect(DISPOSABLE_NAME.test(name)).toBe(false);
    },
  );
});

describe("when a database may be dropped", () => {
  const name = "rio_0123456789ab_test";
  const token = "a".repeat(32);

  it("only when the name has the disposable shape, is the one this run created, and carries this run's marker", () => {
    expect(() => assertMayDrop(name, name, token, token)).not.toThrow();
  });

  it.each([
    ["a database that is not a disposable name (rio_hospital)", ["rio_hospital", "rio_hospital", token, token]],
    ["a disposable-looking name that this run did not create", ["rio_ffffffffffff_test", name, token, token]],
    ["a database with no marker", [name, name, token, null]],
    ["a database with someone else's marker", [name, name, token, "b".repeat(32)]],
    ["an injection-shaped name", ["rio_0123456789ab_test`; DROP DATABASE rio_hospital; --", "rio_0123456789ab_test`; DROP DATABASE rio_hospital; --", token, token]],
  ] as const)("refuses %s", (_label, [candidate, created, written, found]) => {
    expect(refusal(() => assertMayDrop(candidate, created, written, found))).toContain("Refusing to drop");
  });
});

describe("the runner itself (a real child process; no database server is contacted in these cases)", () => {
  const runner = join(import.meta.dirname, "test-mariadb.ts");
  const run = (env: Record<string, string>) => {
    const r = spawnSync(process.execPath, [runner], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 30_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it("is BLOCKED, runs nothing and creates nothing when no test account is configured", () => {
    const r = run({});
    expect(r.code).toBe(3);
    expect(r.err).toContain("BLOCKED");
    expect(r.err).toContain("NOT RUN");
    expect(r.out).not.toContain("test database:"); // it never got as far as creating one
    expect(r.out).not.toMatch(/RUN\s+v\d/); // vitest never started
  });

  it.each([
    ["root", "mysql://root:secret-pw-1@127.0.0.1:1"],
    ["rio_app", "mysql://rio_app:secret-pw-1@127.0.0.1:1"],
    ["a URL that names rio_hospital", "mysql://rio_tester:secret-pw-1@127.0.0.1:1/rio_hospital"],
    ["a remote host", "mysql://rio_tester:secret-pw-1@db.example.org:1"],
  ])("refuses %s before opening any connection, and never falls back to anything else", (_label, url) => {
    const r = run({ RIO_TEST_SERVER_URL: url });
    expect(r.code).toBe(4);
    expect(r.err).toContain("REFUSED");
    expect(`${r.out}${r.err}`).not.toMatch(/secret-pw|ECONNREFUSED|BLOCKED: could not sign in/); // it never tried to connect
  });

  it("refuses the application's own account even under a different-looking URL", () => {
    const r = run({ RIO_TEST_SERVER_URL: "mysql://rio_tester:secret-pw-1@127.0.0.1:1", DATABASE_URL: "mysql://rio_tester:other-pw-1@127.0.0.1:3306/rio_hospital" });
    expect(r.code).toBe(4);
    expect(r.err).toContain("same account");
  });

  it("is BLOCKED with the error number only (never the credentials) when the server does not answer", () => {
    const r = run({ RIO_TEST_SERVER_URL: "mysql://rio_tester:secret-pw-1@127.0.0.1:1" });
    expect(r.code).toBe(3);
    expect(r.err).toContain("BLOCKED: could not sign in");
    expect(`${r.out}${r.err}`).not.toMatch(/secret-pw|rio_tester/);
    expect(r.out).not.toContain("test database:");
  });
});

// ---- the grant the guide tells the owner to create -----------------------------------------------------------------------------------------------

/** How MariaDB reads a database name in GRANT ... ON `pattern`.*: `\_` and `\%` are literal, a bare `_` is any one character, a bare `%` is any run of characters. */
function grantPatternMatches(pattern: string, name: string): boolean {
  const literal = (c: string) => c.replace(/[\\^$.*+?()[\]{}|]/g, (m) => `\\${m}`);
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    const next = pattern.charAt(i + 1);
    if (c === "\\" && (next === "_" || next === "%")) {
      source += literal(next);
      i++;
    } else if (c === "_") source += ".";
    else if (c === "%") source += ".*";
    else source += literal(c);
  }
  return new RegExp(`^${source}$`, "i").test(name);
}

describe("the documented grant on `rio\\_%\\_test`", () => {
  const guide = readFileSync(join(import.meta.dirname, "../../LOCAL_DEVELOPMENT.md"), "utf8");
  const documented = /GRANT ALL PRIVILEGES ON `([^`]+)`\.\* TO 'rio_tester'@'localhost'/.exec(guide)?.[1];

  it("is written in the guide exactly once, and is the pattern tested here", () => {
    expect(documented).toBe("rio\\_%\\_test"); // with the backslashes: they make the underscores literal
    expect(guide.match(/GRANT ALL PRIVILEGES/g)).toHaveLength(2); // one for rio_app (rio_hospital only), one for rio_tester
    expect(guide).not.toMatch(/GRANT[^;]*WITH GRANT OPTION/i); // the test account can never pass its rights on
    expect(guide).not.toMatch(/GRANT[^;]*ON \*\.\*/i); // and never has server-wide rights
  });

  it("covers every database name the runner can generate", () => {
    for (let i = 0; i < 200; i++) expect(grantPatternMatches(documented!, newDisposableName())).toBe(true);
  });

  it.each([
    "rio_hospital", "rio_test", "rio", "rio_", "mysql", "information_schema", "performance_schema", "phpmyadmin", "test", "invictus", "mypetmart", "mypetmart_test", "pixel_eye_blog_db", "whatnexus", "rti_saathi",
    "rio_hospital_backup", "xrio_abc_test", "rio_abc_testx",
  ])("does NOT cover %s", (name) => {
    expect(grantPatternMatches(documented!, name)).toBe(false);
  });

  it("is what the runner would need and no wider: the underscores are literal, so only names starting rio_ and ending _test match", () => {
    expect(grantPatternMatches("rio\\_%\\_test", "rio_anything_test")).toBe(true);
    expect(grantPatternMatches("rio\\_%\\_test", "rioXanythingXtest")).toBe(false); // unescaped underscores would have matched this
    expect(grantPatternMatches("rio_%_test", "rioXanythingXtest")).toBe(true); // which is exactly why the guide escapes them
  });
});
