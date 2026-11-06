import { describe, expect, it } from "vitest";
import { assertReadOnlySql, assertSafeLiveTarget, GuardError, INSPECTIONS, parseSessionPoolerUrl, planAdvisors, planDevCommand, planInspection, projectRefFromUrl, readProductionRef, redact } from "./db-dev";

const PROD = "prodprodprodprodprod"; // 20 chars
const DEV = "devdevdevdevdevdevde"; // 20 chars

describe("planDevCommand", () => {
  it("builds an explicit --remote=<dev ref> dry run that cannot write", () => {
    const plan = planDevCommand("dry-run", { RIO_DEV_PROJECT_REF: DEV }, PROD, null);
    expect(plan.args).toEqual(["supabase", "db", "push", `--remote=${DEV}`, "--dry-run"]);
    expect(plan.writes).toBe(false);
    expect(plan.args).not.toContain("--yes");
  });

  it("never uses a bare --remote (the linked project)", () => {
    for (const cmd of ["check", "dry-run"] as const) {
      expect(planDevCommand(cmd, { RIO_DEV_PROJECT_REF: DEV }, PROD, null).args.some((a) => a === "--remote")).toBe(false);
    }
  });

  it("refuses the production ref, a missing ref, and malformed refs", () => {
    expect(() => planDevCommand("dry-run", { RIO_DEV_PROJECT_REF: PROD }, PROD, null)).toThrow(GuardError);
    expect(() => planDevCommand("dry-run", {}, PROD, null)).toThrow(GuardError);
    for (const bad of ["short", `${DEV}; rm -rf /`, DEV.toUpperCase(), `${DEV}x`]) {
      expect(() => planDevCommand("dry-run", { RIO_DEV_PROJECT_REF: bad }, PROD, null)).toThrow(GuardError);
    }
  });

  it("refuses when the CLI is linked to some other project", () => {
    expect(() => planDevCommand("dry-run", { RIO_DEV_PROJECT_REF: DEV }, PROD, PROD)).toThrow(/linked/);
    expect(() => planDevCommand("dry-run", { RIO_DEV_PROJECT_REF: DEV }, PROD, DEV)).not.toThrow();
  });

  it("allows a real push only with a matching confirmation", () => {
    expect(() => planDevCommand("push", { RIO_DEV_PROJECT_REF: DEV }, PROD, null)).toThrow(/RIO_CONFIRM_PUSH/);
    expect(() => planDevCommand("push", { RIO_DEV_PROJECT_REF: DEV, RIO_CONFIRM_PUSH: PROD }, PROD, null)).toThrow(GuardError);
    const plan = planDevCommand("push", { RIO_DEV_PROJECT_REF: DEV, RIO_CONFIRM_PUSH: DEV }, PROD, null);
    expect(plan.writes).toBe(true);
    expect(plan.args).toContain("--yes");
  });
});

describe("assertSafeLiveTarget", () => {
  const PUB = "sb_publishable_fakefakefakefakefake";
  const SEC = "sb_secret_fakefakefakefakefake";
  const keys = { RIO_LIVE_PUBLISHABLE_KEY: PUB, RIO_LIVE_SECRET_KEY: SEC };
  const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.sig`;
  const hosted = (extra: Record<string, string> = {}) => ({ ...keys, RIO_LIVE_URL: `https://${DEV}.supabase.co`, RIO_DEV_PROJECT_REF: DEV, RIO_LIVE_CONFIRM: DEV, ...extra });

  it("refuses production, unconfirmed hosted targets and missing settings", () => {
    expect(() => assertSafeLiveTarget(hosted({ RIO_LIVE_URL: `https://${PROD}.supabase.co`, RIO_LIVE_CONFIRM: PROD, RIO_DEV_PROJECT_REF: PROD }), PROD)).toThrow(/production/);
    expect(() => assertSafeLiveTarget(hosted({ RIO_LIVE_CONFIRM: "" }), PROD)).toThrow(/RIO_LIVE_CONFIRM/);
    expect(() => assertSafeLiveTarget({ RIO_LIVE_URL: `https://${DEV}.supabase.co` }, PROD)).toThrow(GuardError);
    expect(() => assertSafeLiveTarget(hosted({ RIO_LIVE_URL: "https://example.com" }), PROD)).toThrow(GuardError);
  });

  it("requires RIO_LIVE_URL, RIO_DEV_PROJECT_REF and RIO_LIVE_CONFIRM to agree", () => {
    expect(() => assertSafeLiveTarget(hosted({ RIO_DEV_PROJECT_REF: "" }), PROD)).toThrow(/RIO_DEV_PROJECT_REF/);
    expect(() => assertSafeLiveTarget(hosted({ RIO_DEV_PROJECT_REF: "zzzzzzzzzzzzzzzzzzzz" }), PROD)).toThrow(/RIO_DEV_PROJECT_REF/);
    expect(() => assertSafeLiveTarget(hosted({ RIO_LIVE_CONFIRM: "zzzzzzzzzzzzzzzzzzzz" }), PROD)).toThrow(/RIO_LIVE_CONFIRM/);
  });

  it("checks key kinds without echoing them", () => {
    for (const bad of [{ RIO_LIVE_PUBLISHABLE_KEY: SEC }, { RIO_LIVE_SECRET_KEY: PUB }, { RIO_LIVE_PUBLISHABLE_KEY: "pk" }, { RIO_LIVE_SECRET_KEY: "sk" }]) {
      let error: unknown;
      try {
        assertSafeLiveTarget(hosted(bad as unknown as Record<string, string>), PROD);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(GuardError);
      for (const leak of [PUB, SEC, "pk", "sk"]) expect((error as Error).message).not.toContain(` ${leak} `);
    }
    expect(assertSafeLiveTarget(hosted({ RIO_LIVE_PUBLISHABLE_KEY: jwt("anon"), RIO_LIVE_SECRET_KEY: jwt("service_role") }), PROD).ref).toBe(DEV);
    expect(() => assertSafeLiveTarget(hosted({ RIO_LIVE_PUBLISHABLE_KEY: jwt("service_role") }), PROD)).toThrow(/publishable/);
    expect(() => assertSafeLiveTarget(hosted({ RIO_LIVE_SECRET_KEY: jwt("anon") }), PROD)).toThrow(/secret/);
  });

  it("refuses the production publishable key", () => {
    expect(() => assertSafeLiveTarget(hosted(), PROD, PUB)).toThrow(/production key/);
    expect(assertSafeLiveTarget(hosted(), PROD, "sb_publishable_someotherprodkey").ref).toBe(DEV);
  });

  it("accepts a confirmed dev project and a local stack", () => {
    expect(assertSafeLiveTarget(hosted(), PROD).ref).toBe(DEV);
    expect(assertSafeLiveTarget({ ...keys, RIO_LIVE_URL: "http://127.0.0.1:54321" }, PROD).ref).toBe("local");
  });
});

describe("helpers", () => {
  it("extracts project refs only from supabase.co URLs", () => {
    expect(projectRefFromUrl(`https://${DEV}.supabase.co`)).toBe(DEV);
    expect(projectRefFromUrl("https://evil.example.com")).toBeNull();
    expect(projectRefFromUrl("not a url")).toBeNull();
  });

  it("derives the production ref from .env without exposing it", () => {
    const ref = readProductionRef(".env");
    expect(ref === null || /^[a-z0-9]{20}$/.test(ref)).toBe(true);
  });
});

// The pooler tests use obviously fake secrets. SECRET must never appear in any message or output.
const SECRET = "s3cr3t-P@ss/w0rd#1";
const ENCODED = encodeURIComponent(SECRET);
const HOST = "aws-1-ap-southeast-1.pooler.supabase.com";
const poolerUrl = (over: Partial<{ user: string; host: string; port: string; path: string; tail: string; scheme: string; pass: string }> = {}) => {
  const o = { user: `postgres.${DEV}`, host: HOST, port: "5432", path: "/postgres", tail: "", scheme: "postgresql", pass: ENCODED, ...over };
  return `${o.scheme}://${o.user}:${o.pass}@${o.host}:${o.port}${o.path}${o.tail}`;
};

describe("parseSessionPoolerUrl", () => {
  it("accepts the dev Session Pooler URL and returns the decoded password and host only", () => {
    expect(parseSessionPoolerUrl(poolerUrl(), DEV, PROD)).toEqual({ host: HOST, password: SECRET });
    expect(parseSessionPoolerUrl(poolerUrl({ scheme: "postgres", host: "aws-0-eu-west-2.pooler.supabase.com" }), DEV, PROD).host).toBe("aws-0-eu-west-2.pooler.supabase.com");
  });

  const refusals: [string, ReturnType<typeof poolerUrl>, RegExp][] = [
    ["Transaction Pooler port 6543", poolerUrl({ port: "6543" }), /5432/],
    ["any other port", poolerUrl({ port: "5433" }), /5432/],
    ["no explicit port", poolerUrl().replace(":5432", ""), /5432/],
    ["direct database host (IPv6 only)", poolerUrl({ host: `db.${DEV}.supabase.co` }), /Session Pooler host/],
    ["a lookalike host", poolerUrl({ host: `${HOST}.evil.example` }), /Session Pooler host/],
    ["a host that only ends like the pooler", poolerUrl({ host: "evil-pooler.supabase.com" }), /Session Pooler host/],
    ["an arbitrary host", poolerUrl({ host: "example.com" }), /Session Pooler host/],
    ["the production project username", poolerUrl({ user: `postgres.${PROD}` }), /production/],
    ["a different project's username", poolerUrl({ user: "postgres.zzzzzzzzzzzzzzzzzzzz" }), /do not match/],
    ["the bare postgres username", poolerUrl({ user: "postgres" }), /do not match/],
    ["another database role", poolerUrl({ user: `service_role.${DEV}` }), /do not match/],
    ["a non-postgres database", poolerUrl({ path: "/other" }), /\/postgres/],
    ["query parameters", poolerUrl({ tail: "?sslmode=disable" }), /query/],
    ["a fragment", poolerUrl({ tail: "#x" }), /query/],
    ["http scheme", poolerUrl({ scheme: "http" }), /postgresql/],
    ["a missing password", `postgresql://postgres.${DEV}@${HOST}:5432/postgres`, /no password/],
    ["garbage", "not a url", /valid URL/],
  ];
  for (const [name, url, message] of refusals) {
    it(`refuses ${name}, without echoing any credential`, () => {
      let error: unknown;
      try {
        parseSessionPoolerUrl(url, DEV, PROD);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(GuardError);
      const text = (error as Error).message;
      expect(text).toMatch(message);
      for (const leak of [SECRET, ENCODED, url, DEV, PROD, HOST]) expect(text).not.toContain(leak);
    });
  }
});

describe("planDevCommand with a Session Pooler URL", () => {
  const env = (extra: Record<string, string> = {}) => ({ RIO_DEV_PROJECT_REF: DEV, SUPABASE_DEV_POOLER_URL: poolerUrl(), SUPABASE_DB_PASSWORD: "other-db-password", ...extra });

  it("targets the pooler URL for a dry run, with no writes and no --yes", () => {
    const plan = planDevCommand("dry-run", env(), PROD, null);
    expect(plan.method).toBe("session-pooler");
    expect(plan.args).toEqual(["supabase", "db", "push", `--remote=${poolerUrl()}`, "--dry-run"]);
    expect(plan.writes).toBe(false);
    expect(plan.poolerHost).toBe(HOST);
  });

  it("requires the dev ref and keeps every production safeguard", () => {
    expect(() => planDevCommand("dry-run", { SUPABASE_DEV_POOLER_URL: poolerUrl() }, PROD, null)).toThrow(/RIO_DEV_PROJECT_REF/);
    expect(() => planDevCommand("dry-run", env({ RIO_DEV_PROJECT_REF: PROD, SUPABASE_DEV_POOLER_URL: poolerUrl({ user: `postgres.${PROD}` }) }), PROD, null)).toThrow(/production project from \.env/);
    expect(() => planDevCommand("dry-run", env(), PROD, PROD)).toThrow(/linked/);
    expect(() => planDevCommand("dry-run", env({ SUPABASE_DEV_POOLER_URL: poolerUrl({ user: `postgres.${PROD}` }) }), PROD, null)).toThrow(/production/);
  });

  it("refuses the Transaction Pooler even when everything else is right", () => {
    expect(() => planDevCommand("dry-run", env({ SUPABASE_DEV_POOLER_URL: poolerUrl({ port: "6543" }) }), PROD, null)).toThrow(/5432/);
  });

  it("still needs the typed confirmation for a real push", () => {
    expect(() => planDevCommand("push", env(), PROD, null)).toThrow(/RIO_CONFIRM_PUSH/);
    expect(planDevCommand("push", env({ RIO_CONFIRM_PUSH: DEV }), PROD, null).writes).toBe(true);
  });

  it("lists every secret for redaction", () => {
    const plan = planDevCommand("dry-run", env(), PROD, null);
    expect(plan.secrets).toEqual(expect.arrayContaining([poolerUrl(), SECRET, "other-db-password"]));
  });

  it("falls back to the direct connection by ref only when no URL is set", () => {
    const plan = planDevCommand("dry-run", { RIO_DEV_PROJECT_REF: DEV }, PROD, null);
    expect(plan.method).toBe("direct");
    expect(plan.args).toContain(`--remote=${DEV}`);
  });
});

describe("redact", () => {
  it("removes passwords (raw and encoded), full URLs and any postgres URL from CLI output", () => {
    const output = [
      `connecting to ${poolerUrl()}`,
      `password authentication failed for user "postgres.${DEV}" (${SECRET})`,
      `retry with ${ENCODED}`,
      "fallback postgres://other:hunter2@example.com:5432/db?sslmode=require",
    ].join("\n");
    const clean = redact(output, [poolerUrl(), SECRET, "unrelated-secret"]);
    for (const leak of [SECRET, ENCODED, "hunter2", poolerUrl(), "postgres://other"]) expect(clean).not.toContain(leak);
    expect(clean).toContain("[redacted");
  });

  it("leaves harmless output untouched and ignores empty secrets", () => {
    expect(redact("Would push migrations:\n 20261105000100_core_schema.sql", ["", undefined])).toBe("Would push migrations:\n 20261105000100_core_schema.sql");
  });
});

describe("read-only inspection", () => {
  it("every built-in inspection query is a single read-only statement", () => {
    expect(Object.keys(INSPECTIONS).length).toBeGreaterThanOrEqual(15);
    for (const [name, sql] of Object.entries(INSPECTIONS)) expect(() => assertReadOnlySql(sql), name).not.toThrow();
  });

  it("refuses anything that could write or have side effects", () => {
    for (const sql of [
      "delete from public.events",
      "select 1; drop table public.events",
      "with gone as (delete from public.events returning *) select * from gone",
      "select set_config('request.jwt.claims', '{}', false)",
      "select nextval('x')",
      "update public.events set min_age = 1",
      "insert into public.events values (1)",
      "create table x (a int)",
      "grant select on public.events to anon",
      "select pg_terminate_backend(1)",
      "",
    ]) {
      expect(() => assertReadOnlySql(sql), sql).toThrow(GuardError);
    }
    expect(() => assertReadOnlySql("select 'delete from x' as harmless")).not.toThrow(); // keywords inside string literals are data
  });

  const env = { RIO_DEV_PROJECT_REF: DEV, SUPABASE_DEV_POOLER_URL: poolerUrl() };

  it("runs through the same dev-only guards, with --read-only and no --yes or --dry-run", () => {
    const plan = planInspection(env, PROD, null, "events");
    expect(plan.args.slice(0, 3)).toEqual(["supabase", "db", "query"]);
    expect(plan.args).toContain(`--remote=${poolerUrl()}`);
    expect(plan.args).toContain("--read-only");
    expect(plan.args).not.toContain("--yes");
    expect(plan.writes).toBe(false);
    expect(() => planInspection({ ...env, RIO_DEV_PROJECT_REF: PROD }, PROD, null, "events")).toThrow(GuardError);
    expect(() => planInspection({ ...env, SUPABASE_DEV_POOLER_URL: poolerUrl({ port: "6543" }) }, PROD, null, "events")).toThrow(/5432/);
    expect(() => planInspection(env, PROD, PROD, "events")).toThrow(/linked/);
  });

  it("does not accept arbitrary SQL by name", () => {
    expect(() => planInspection(env, PROD, null, "select 1")).toThrow(/Unknown inspection/);
    expect(() => planInspection(env, PROD, null, "events; drop table x")).toThrow(/Unknown inspection/);
  });

  it("builds a read-only advisors command for the dev target", () => {
    const plan = planAdvisors(env, PROD, null);
    expect(plan.args.slice(0, 3)).toEqual(["supabase", "db", "advisors"]);
    expect(plan.args).toContain(`--remote=${poolerUrl()}`);
    expect(plan.args).not.toContain("--yes");
    expect(plan.writes).toBe(false);
  });
});
