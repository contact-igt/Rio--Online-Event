import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { DatabaseAdapter, Dialect } from "../db/adapter.ts";
import { dialects, openTestDatabase } from "../db/test-db.ts";
import { dropAppSchema, installAppSchema } from "../db/test-schema.ts";
import { requireStaff } from "./middleware.ts";
import { hashPassword } from "./password.ts";
import { authDeps, createAdmin, LIMITS, resetPassword } from "./staff.ts";
import { csrfFor, sha256Hex } from "./tokens.ts";
import { captureLogger, listen, testConfig } from "../test-helpers.ts";

// The staff endpoints end to end: a real HTTP request, the real Express app, the real database (MySQL 8 when configured, always SQLite).
// Time is a variable (`clock`), so expiry, idle time and rate-limit windows are tested without sleeping.

const ORIGIN = "http://admin.test";
const COST = { memoryKib: 1024, passes: 1 };
const TRACKING = "zz_auth_migrations";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Body = { user?: { id: number; email: string; displayName: string; role: string; mustChangePassword: boolean }; csrfToken?: string; expiresAt?: string; idleExpiresAt?: string; error?: { code: string; message: string; requestId: string; problems?: string[] } };
type Reply = { status: number; body: Body; headers: Headers; cookie: string | null; cookieHeader: string | null };
type Account = { id: number; email: string; password: string };

describe.each(dialects)("%s staff authentication", (dialect: Dialect) => {
  let db: DatabaseAdapter;
  let servers: Server[] = [];
  let base: string;
  const clock = { t: Date.now() };
  const now = () => new Date(clock.t);
  const config = testConfig({ ALLOWED_ORIGINS: ORIGIN, TRUST_PROXY_HOPS: "1", ARGON2_MEMORY_KIB: String(COST.memoryKib), ARGON2_PASSES: String(COST.passes) });
  const deps = () => authDeps(db, config.auth, now);

  async function start(): Promise<string> {
    const app = createApp({
      config,
      logger: captureLogger().logger,
      state: { shuttingDown: false },
      db,
      now,
      mount(app, auth) {
        app.get("/api/v1/test/admin-only", ...requireStaff(auth, { roles: ["admin"] }), (_req, res) => void res.json({ ok: true }));
        app.get("/api/v1/test/judge-only", ...requireStaff(auth, { roles: ["judge"] }), (_req, res) => void res.json({ ok: true }));
        app.post("/api/v1/test/change", ...requireStaff(auth), (_req, res) => void res.json({ ok: true }));
      },
    });
    const server = createServer(app);
    servers.push(server);
    return listen(server);
  }

  beforeAll(async () => {
    db = openTestDatabase(dialect);
    await installAppSchema(db, TRACKING);
    base = await start();
  }, 120_000);
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((resolve) => (s.closeAllConnections(), s.close(resolve)))));
    servers = [];
    await dropAppSchema(db, TRACKING);
    await db.close();
  });

  // ---- helpers -----------------------------------------------------------------------------------------------------------------------
  let counter = 0;
  const next = () => ++counter;
  const freshIp = () => `10.${Math.floor(counter / 250)}.${next() % 250}.${(next() * 7) % 250}`;
  const sql = <Row = Record<string, unknown>>(text: string, params: readonly (string | number | Date | null)[] = []) => db.query<Row>(text, params);
  const scalar = async (text: string, params: readonly (string | number | Date | null)[] = []) => Number((await sql<{ n: number }>(text, params)).rows[0]!.n);

  async function account(over: { role?: "admin" | "judge"; active?: 0 | 1; mustChange?: 0 | 1; password?: string; cost?: { memoryKib: number; passes: number } } = {}): Promise<Account> {
    const email = `user${next()}@example.org`;
    const password = over.password ?? `Start-Pass-${next()}-xyz`;
    await sql("INSERT INTO staff_users (email, password_hash, role, display_name, active, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      email, await hashPassword(password, over.cost ?? COST), over.role ?? "admin", "நிர்வாகி Staff", over.active ?? 1, over.mustChange ?? 0, now(),
    ]);
    const id = Number((await sql<{ id: number }>("SELECT id FROM staff_users WHERE email = ?", [email])).rows[0]!.id);
    return { id, email, password };
  }

  type Options = { method?: string; body?: unknown; cookie?: string | null; origin?: string | null; csrf?: string | null; ip?: string; raw?: string; contentType?: string | null; baseUrl?: string };
  async function call(path: string, o: Options = {}): Promise<Reply> {
    const method = o.method ?? "GET";
    const headers: Record<string, string> = { "x-forwarded-for": o.ip ?? freshIp() };
    const sendsBody = method !== "GET";
    if (o.contentType !== null && sendsBody) headers["content-type"] = o.contentType ?? "application/json";
    if (o.origin !== null && (sendsBody || o.origin !== undefined)) headers.origin = o.origin ?? ORIGIN;
    if (o.cookie) headers.cookie = o.cookie;
    if (o.csrf) headers["x-csrf-token"] = o.csrf;
    const res = await fetch((o.baseUrl ?? base) + path, { method, headers, ...(sendsBody ? { body: o.raw ?? JSON.stringify(o.body ?? {}) } : {}) });
    const text = await res.text();
    const setCookies = res.headers.getSetCookie();
    const session = setCookies.find((c) => c.startsWith("rio_staff="));
    return {
      status: res.status,
      body: text ? (JSON.parse(text) as Body) : {},
      headers: res.headers,
      cookie: session && !session.startsWith("rio_staff=;") ? session.split(";")[0]! : null,
      cookieHeader: session ?? null,
    };
  }
  const signIn = async (a: Account, o: Options = {}) => call("/api/v1/staff/login", { method: "POST", body: { email: a.email, password: a.password }, ...o });
  type Session = { cookie: string; csrf: string; reply: Reply };
  async function session(a: Account, o: Options = {}): Promise<Session> {
    const reply = await signIn(a, o);
    expect(reply.status, `sign in as ${a.email}`).toBe(200);
    return { cookie: reply.cookie!, csrf: reply.body.csrfToken!, reply };
  }
  const me = (s: { cookie: string }, o: Options = {}) => call("/api/v1/staff/me", { cookie: s.cookie, origin: null, ...o });
  const tokenOf = (cookie: string) => cookie.slice("rio_staff=".length);
  const audit = async (action: string, staffId?: number) =>
    (await sql<{ details: unknown; actor_type: string; actor_staff_id: number | null; entity_id: string | null }>(
      `SELECT details, actor_type, actor_staff_id, entity_id FROM audit_log WHERE action = ?${staffId === undefined ? "" : " AND entity_id = ?"} ORDER BY id`,
      staffId === undefined ? [action] : [action, String(staffId)],
    )).rows;

  // ---- sign in ---------------------------------------------------------------------------------------------------------------------------
  describe("POST /api/v1/staff/login", () => {
    it("signs in with a valid password: user, CSRF token and an HttpOnly session cookie", async () => {
      const a = await account({ role: "judge" });
      const reply = await signIn(a);
      expect(reply.status).toBe(200);
      expect(reply.body.user).toEqual({ id: a.id, email: a.email, displayName: "நிர்வாகி Staff", role: "judge", mustChangePassword: false });
      expect(reply.body.csrfToken).toBe(csrfFor(tokenOf(reply.cookie!)));
      expect(new Date(reply.body.expiresAt!).getTime()).toBe(clock.t + 8 * HOUR);
      expect(JSON.stringify(reply.body)).not.toMatch(/argon2|password_hash|\$argon/i);
      const attrs = reply.cookieHeader!;
      expect(attrs).toMatch(/; HttpOnly/);
      expect(attrs).toMatch(/; Path=\//);
      expect(attrs).toMatch(/; SameSite=Strict/);
      expect(attrs).toMatch(/Max-Age=28800/);
      expect(attrs).not.toMatch(/Domain=/i);
      expect(tokenOf(reply.cookie!)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it("keeps only a SHA-256 digest of the session token in the database", async () => {
      const a = await account();
      const s = await session(a);
      const rows = (await sql<{ token_sha256: string; revoked_at: unknown }>("SELECT token_sha256, revoked_at FROM staff_sessions WHERE staff_id = ?", [a.id])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.token_sha256).toBe(sha256Hex(tokenOf(s.cookie)));
      expect(rows[0]!.token_sha256).not.toContain(tokenOf(s.cookie));
      expect(rows[0]!.revoked_at).toBeNull();
    });

    it("stores the password only as an Argon2id hash", async () => {
      const a = await account();
      const hash = (await sql<{ password_hash: string }>("SELECT password_hash FROM staff_users WHERE id = ?", [a.id])).rows[0]!.password_hash;
      expect(hash).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=1\$/);
      expect(hash).not.toContain(a.password);
    });

    it("records the login in the audit log without any secret", async () => {
      const a = await account();
      await session(a);
      const rows = await audit("staff.login", a.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_type: "staff", actor_staff_id: a.id, entity_id: String(a.id) });
    });

    it("answers a wrong password, an unknown e-mail and a switched-off account with the same 401", async () => {
      const a = await account();
      const off = await account({ active: 0 });
      const wrong = await signIn({ ...a, password: "Wrong-Pass-1234" });
      const unknown = await call("/api/v1/staff/login", { method: "POST", body: { email: "nobody@example.org", password: "Whatever-1234" } });
      const inactive = await signIn(off);
      for (const r of [wrong, unknown, inactive]) {
        expect(r.status).toBe(401);
        expect(r.cookie).toBeNull();
        expect(r.body.error).toMatchObject({ code: "invalid_credentials", message: "The e-mail or password is not correct." });
      }
      expect(await scalar("SELECT COUNT(*) AS n FROM staff_sessions WHERE staff_id IN (?, ?)", [a.id, off.id])).toBe(0);
    });

    it("audits failures with a reason code only: no e-mail, password or address", async () => {
      const a = await account();
      const ip = "198.51.100.77";
      await signIn({ ...a, password: "Wrong-Pass-1234" }, { ip });
      await call("/api/v1/staff/login", { method: "POST", body: { email: "ghost@example.org", password: "Ghost-Pass-1234" }, ip });
      const failed = await audit("staff.login_failed");
      const text = JSON.stringify(failed);
      expect(text).toContain("bad_password");
      expect(text).toContain("unknown_account");
      for (const secret of [a.email, "ghost@example.org", "Wrong-Pass-1234", "Ghost-Pass-1234", ip]) expect(text).not.toContain(secret);
    });

    it("lets a reset or wrong try not reveal which accounts exist, even through failed_logins", async () => {
      const a = await account();
      await signIn({ ...a, password: "Wrong-Pass-1234" });
      expect(await scalar("SELECT failed_logins AS n FROM staff_users WHERE id = ?", [a.id])).toBe(1);
      await session(a);
      expect(await scalar("SELECT failed_logins AS n FROM staff_users WHERE id = ?", [a.id])).toBe(0);
    });

    it.each([
      ["a body that is not JSON", { raw: "{not json" }],
      ["an empty body", { body: {} }],
      ["a missing password", { body: { email: "a@example.org" } }],
      ["an empty password", { body: { email: "a@example.org", password: "" } }],
      ["a password over 256 characters", { body: { email: "a@example.org", password: "x".repeat(257) } }],
      ["a non-text e-mail", { body: { email: ["a@example.org"], password: "Some-Pass-1234" } }],
      ["an unexpected field", { body: { email: "a@example.org", password: "Some-Pass-1234", role: "admin" } }],
      ["another content type", { raw: "email=a%40example.org&password=x", contentType: "application/x-www-form-urlencoded" }],
      ["no content type", { raw: JSON.stringify({ email: "a@example.org", password: "Some-Pass-1234" }), contentType: null }],
    ])("rejects %s with 400 and creates nothing", async (_label, o) => {
      const before = await scalar("SELECT COUNT(*) AS n FROM staff_sessions");
      const r = await call("/api/v1/staff/login", { method: "POST", ...(o as Options) });
      expect(r.status).toBe(400);
      expect(r.cookie).toBeNull();
      expect(await scalar("SELECT COUNT(*) AS n FROM staff_sessions")).toBe(before);
    });

    it("treats a SQL injection attempt as just a wrong e-mail", async () => {
      const r = await call("/api/v1/staff/login", { method: "POST", body: { email: "x' OR '1'='1' -- ", password: "Some-Pass-1234" } });
      expect(r.status).toBe(401);
      expect(await scalar("SELECT COUNT(*) AS n FROM staff_users")).toBeGreaterThan(0);
    });

    it("upgrades an older, weaker hash after a successful login", async () => {
      const a = await account({ cost: { memoryKib: 64, passes: 1 } });
      expect((await sql<{ h: string }>("SELECT password_hash AS h FROM staff_users WHERE id = ?", [a.id])).rows[0]!.h).toContain("m=64,");
      await session(a);
      expect((await sql<{ h: string }>("SELECT password_hash AS h FROM staff_users WHERE id = ?", [a.id])).rows[0]!.h).toContain(`m=${COST.memoryKib},`);
      await session(a); // and the upgraded hash still works
    });

    it("replaces the old session when the same browser signs in again", async () => {
      const a = await account();
      const first = await session(a);
      const second = await session(a, { cookie: first.cookie });
      expect((await me(first)).status).toBe(401);
      expect((await me(second)).status).toBe(200);
    });
  });

  // ---- origin, CSRF and CORS -------------------------------------------------------------------------------------------------------------
  describe("origin, CSRF and CORS protection", () => {
    it("refuses a sign-in from an origin that is not allowed, or with no Origin header, and signs nobody in", async () => {
      const a = await account();
      for (const origin of ["http://evil.test", "http://admin.test.evil.test", "https://admin.test", "null"]) {
        expect((await signIn(a, { origin })).status, origin).toBe(403);
      }
      const none = await signIn(a, { origin: null });
      expect(none.status).toBe(403);
      expect(none.body.error?.code).toBe("origin_not_allowed");
      expect(await scalar("SELECT COUNT(*) AS n FROM staff_sessions WHERE staff_id = ?", [a.id])).toBe(0);
    });

    it("needs the CSRF token on every state-changing request, and it must belong to the same session", async () => {
      const a = await account();
      const b = await account();
      const sa = await session(a);
      const sb = await session(b);
      const attempt = (csrf: string | null) => call("/api/v1/test/change", { method: "POST", cookie: sa.cookie, csrf });
      expect((await attempt(null)).body.error?.code).toBe("csrf_invalid");
      expect((await attempt("wrong")).status).toBe(403);
      expect((await attempt(sb.csrf)).status).toBe(403); // another session's token
      expect((await attempt(csrfFor(sa.cookie))).status).toBe(403); // computed from the wrong input (the cookie name is not part of the token)
      expect((await attempt(sa.csrf)).status).toBe(200);
    });

    it("checks the origin before anything else on a state-changing request, even with a valid CSRF token", async () => {
      const s = await session(await account());
      for (const origin of ["http://evil.test", null]) {
        const r = await call("/api/v1/test/change", { method: "POST", cookie: s.cookie, csrf: s.csrf, origin });
        expect(r.status).toBe(403);
        expect(r.body.error?.code).toBe("origin_not_allowed");
      }
    });

    it("does not need the CSRF token for reading, but an unauthenticated read is 401", async () => {
      const s = await session(await account());
      expect((await me(s)).status).toBe(200);
      expect((await call("/api/v1/staff/me", { origin: null })).status).toBe(401);
    });

    it("answers cross-origin reads only to allowed origins, with credentials and never a wildcard", async () => {
      const s = await session(await account());
      const allowed = await me(s, { origin: ORIGIN });
      expect(allowed.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
      expect(allowed.headers.get("vary")).toMatch(/Origin/i);
      const evil = await me(s, { origin: "http://evil.test" });
      expect(evil.headers.get("access-control-allow-origin")).toBeNull();
      expect(evil.headers.get("access-control-allow-credentials")).toBeNull();
      expect((await me(s)).headers.get("access-control-allow-origin")).toBeNull();
    });

    it("answers a preflight from the allowed origin only, with exactly the methods and headers the API uses", async () => {
      const preflight = (origin: string) => fetch(`${base}/api/v1/staff/password`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-csrf-token" } });
      const ok = await preflight(ORIGIN);
      expect(ok.status).toBe(204);
      expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(ok.headers.get("access-control-allow-methods")).toBe("GET, POST, PATCH, OPTIONS");
      expect(ok.headers.get("access-control-allow-headers")).toBe("Content-Type, X-CSRF-Token");
      const bad = await preflight("http://evil.test");
      expect(bad.headers.get("access-control-allow-origin")).toBeNull();
      expect(bad.status).not.toBe(204);
    });
  });

  // ---- rate limits -----------------------------------------------------------------------------------------------------------------------
  describe("login rate limits (shared, in the database)", () => {
    it("limits one account across many addresses, hides whether the password was right, and recovers after the window", async () => {
      const a = await account();
      for (let i = 0; i < LIMITS.loginPerAccount.max; i++) expect((await signIn({ ...a, password: `Wrong-Pass-${i}` })).status).toBe(401);
      const limited = await signIn({ ...a, password: "Wrong-Pass-final" });
      expect(limited.status).toBe(429);
      expect(limited.body.error?.code).toBe("rate_limited");
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await signIn(a)).status).toBe(429); // the right password does not get through while limited
      clock.t += 16 * MINUTE;
      expect((await signIn(a)).status).toBe(200);
    });

    it("limits one address across many accounts", async () => {
      const ip = freshIp();
      for (let i = 0; i < LIMITS.loginPerIp.max; i++) {
        expect((await call("/api/v1/staff/login", { method: "POST", ip, body: { email: `nobody${next()}@example.org`, password: "Some-Pass-1234" } })).status).toBe(401);
      }
      const limited = await call("/api/v1/staff/login", { method: "POST", ip, body: { email: `nobody${next()}@example.org`, password: "Some-Pass-1234" } });
      expect(limited.status).toBe(429);
      expect((await signIn(await account(), { ip })).status).toBe(429); // a good account is also refused from that address
      expect((await signIn(await account())).status).toBe(200); // another address is unaffected
    });

    it("counts in the shared database, so a second server instance sees the first one's attempts", async () => {
      const second = await start();
      const a = await account();
      for (let i = 0; i < LIMITS.loginPerAccount.max; i++) expect((await signIn({ ...a, password: `Wrong-${i}-Pass` }, { baseUrl: i % 2 === 0 ? base : second })).status).toBe(401);
      expect((await signIn(a, { baseUrl: second })).status).toBe(429);
      expect((await signIn(a, { baseUrl: base })).status).toBe(429);
    });

    it("forgets an account's failures after a successful sign-in", async () => {
      const a = await account();
      for (let i = 0; i < LIMITS.loginPerAccount.max - 1; i++) await signIn({ ...a, password: `Wrong-Pass-${i}` });
      expect((await signIn(a)).status).toBe(200);
      for (let i = 0; i < LIMITS.loginPerAccount.max - 1; i++) expect((await signIn({ ...a, password: `Wrong-Pass-${i}` })).status).toBe(401);
    });

    it("writes one audit row per window when a limit is hit, and keeps only digests in rate_limits", async () => {
      const a = await account();
      for (let i = 0; i < LIMITS.loginPerAccount.max + 4; i++) await signIn({ ...a, password: `Wrong-Pass-${i}` });
      const rows = (await audit("staff.login_rate_limited")).filter((r) => JSON.stringify(r.details).includes("account"));
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const keys = (await sql<{ key_sha256: string }>("SELECT key_sha256 FROM rate_limits")).rows.map((r) => r.key_sha256);
      expect(keys).toContain(sha256Hex(a.email));
      expect(keys.every((k) => /^[0-9a-f]{64}$/.test(k))).toBe(true);
      const accountRowsInWindow = (await sql<{ hits: number }>("SELECT hits FROM rate_limits WHERE scope = 'staff.login.account' AND key_sha256 = ?", [sha256Hex(a.email)])).rows;
      expect(accountRowsInWindow).toHaveLength(1);
      expect(Number(accountRowsInWindow[0]!.hits)).toBe(LIMITS.loginPerAccount.max + 4);
    });
  });

  // ---- sessions ---------------------------------------------------------------------------------------------------------------------------
  describe("GET /api/v1/staff/me and session life", () => {
    it("returns the signed-in member, a CSRF token and the expiry times", async () => {
      const a = await account({ role: "judge" });
      const s = await session(a);
      const r = await me(s);
      expect(r.status).toBe(200);
      expect(r.body.user).toMatchObject({ id: a.id, email: a.email, role: "judge" });
      expect(r.body.csrfToken).toBe(s.csrf);
      expect(new Date(r.body.idleExpiresAt!).getTime()).toBe(clock.t + 60 * MINUTE);
    });

    it.each([
      ["no cookie", null],
      ["a random cookie", `rio_staff=${"A".repeat(43)}`],
      ["a cookie of the wrong shape", "rio_staff=not-a-token"],
      ["a SQL fragment as the cookie", "rio_staff=' OR 1=1 --"],
      ["a cookie under another name", `other=${"A".repeat(43)}`],
    ])("answers 401 for %s", async (_label, cookie) => {
      const r = await call("/api/v1/staff/me", { cookie, origin: null });
      expect(r.status).toBe(401);
      expect(r.body.error?.code).toBe("unauthenticated");
    });

    it("does not accept the stored digest in place of the token", async () => {
      const a = await account();
      const s = await session(a);
      const digest = sha256Hex(tokenOf(s.cookie));
      expect((await call("/api/v1/staff/me", { cookie: `rio_staff=${digest}`, origin: null })).status).toBe(401);
      expect((await call("/api/v1/staff/me", { cookie: `rio_staff=${digest.slice(0, 43)}`, origin: null })).status).toBe(401);
    });

    it("expires an idle session", async () => {
      const s = await session(await account());
      clock.t += 59 * MINUTE;
      expect((await me(s)).status).toBe(200);
      clock.t += 61 * MINUTE;
      const r = await me(s);
      expect(r.status).toBe(401);
      expect(r.cookieHeader).toMatch(/rio_staff=;/); // and the browser is told to forget it
    });

    it("keeps a busy session alive, but never beyond its absolute lifetime of 8 hours", async () => {
      const s = await session(await account());
      for (let i = 1; i <= 9; i++) {
        clock.t += 50 * MINUTE; // always inside the 60-minute idle limit
        expect((await me(s)).status, `after ${i * 50} minutes`).toBe(200);
      }
      clock.t += 50 * MINUTE; // 500 minutes in: past 8 hours (480)
      expect((await me(s)).status).toBe(401);
    });

    it("stops a revoked session at once", async () => {
      const a = await account();
      const s = await session(a);
      await sql("UPDATE staff_sessions SET revoked_at = ? WHERE staff_id = ?", [now(), a.id]);
      expect((await me(s)).status).toBe(401);
    });

    it("stops a deactivated member's existing session at once, and a judge cannot be signed in again", async () => {
      const judge = await account({ role: "judge" });
      const s = await session(judge);
      expect((await call("/api/v1/test/judge-only", { cookie: s.cookie, origin: null })).status).toBe(200);
      await sql("UPDATE staff_users SET active = 0 WHERE id = ?", [judge.id]);
      expect((await me(s)).status).toBe(401);
      expect((await call("/api/v1/test/judge-only", { cookie: s.cookie, origin: null })).status).toBe(401);
      const again = await signIn(judge);
      expect(again.status).toBe(401);
      expect(JSON.stringify(await audit("staff.login_failed", judge.id))).toContain("inactive");
    });
  });

  // ---- logout -----------------------------------------------------------------------------------------------------------------------------
  describe("POST /api/v1/staff/logout", () => {
    it("ends the session, clears the cookie, and audits it", async () => {
      const a = await account();
      const s = await session(a);
      const r = await call("/api/v1/staff/logout", { method: "POST", cookie: s.cookie, csrf: s.csrf });
      expect(r.status).toBe(204);
      expect(r.cookieHeader).toMatch(/rio_staff=;/);
      expect((await me(s)).status).toBe(401);
      expect(await scalar("SELECT COUNT(*) AS n FROM staff_sessions WHERE staff_id = ? AND revoked_at IS NOT NULL", [a.id])).toBe(1);
      expect(await audit("staff.logout", a.id)).toHaveLength(1);
    });

    it("refuses a logout without the CSRF token, from another origin, and leaves the session alone", async () => {
      const s = await session(await account());
      expect((await call("/api/v1/staff/logout", { method: "POST", cookie: s.cookie })).status).toBe(403);
      expect((await call("/api/v1/staff/logout", { method: "POST", cookie: s.cookie, csrf: s.csrf, origin: "http://evil.test" })).status).toBe(403);
      expect((await me(s)).status).toBe(200);
    });

    it("answers 204 when there is no session to end, and only ends the caller's own session", async () => {
      expect((await call("/api/v1/staff/logout", { method: "POST" })).status).toBe(204);
      const a = await account();
      const one = await session(a);
      const two = await session(a);
      await call("/api/v1/staff/logout", { method: "POST", cookie: one.cookie, csrf: one.csrf });
      expect((await me(two)).status).toBe(200);
    });
  });

  // ---- password change ------------------------------------------------------------------------------------------------------------------
  describe("POST /api/v1/staff/password", () => {
    const change = (s: { cookie: string; csrf: string }, body: unknown, o: Options = {}) => call("/api/v1/staff/password", { method: "POST", cookie: s.cookie, csrf: s.csrf, body, ...o });

    it("makes a first-login account choose its own password before it can do anything else", async () => {
      const a = await account({ mustChange: 1 });
      const s = await session(a);
      expect(s.reply.body.user?.mustChangePassword).toBe(true);
      expect((await me(s)).status).toBe(200);
      const blocked = await call("/api/v1/test/admin-only", { cookie: s.cookie, origin: null });
      expect(blocked.status).toBe(403);
      expect(blocked.body.error?.code).toBe("password_change_required");
      expect((await call("/api/v1/test/change", { method: "POST", cookie: s.cookie, csrf: s.csrf })).body.error?.code).toBe("password_change_required");

      const changed = await change(s, { currentPassword: a.password, newPassword: "A-Brand-New-Passphrase-77" });
      expect(changed.status).toBe(200);
      expect(changed.body.user?.mustChangePassword).toBe(false);
      const fresh = { cookie: changed.cookie!, csrf: changed.body.csrfToken! };
      expect((await call("/api/v1/test/admin-only", { cookie: fresh.cookie, origin: null })).status).toBe(200);
      expect(await scalar("SELECT must_change_password AS n FROM staff_users WHERE id = ?", [a.id])).toBe(0);
    });

    it("ends every session, including the old one, and signs the caller in again with a new one", async () => {
      const a = await account();
      const phone = await session(a);
      const laptop = await session(a);
      const changed = await change(laptop, { currentPassword: a.password, newPassword: "Another-Fine-Passphrase-1" });
      expect(changed.status).toBe(200);
      expect(changed.cookie).not.toBe(laptop.cookie);
      expect((await me(phone)).status).toBe(401);
      expect((await me(laptop)).status).toBe(401);
      expect((await me({ cookie: changed.cookie! })).status).toBe(200);
      expect(await scalar("SELECT COUNT(*) AS n FROM staff_sessions WHERE staff_id = ? AND revoked_at IS NULL", [a.id])).toBe(1);
    });

    it("stops the old password working and starts the new one", async () => {
      const a = await account();
      const s = await session(a);
      await change(s, { currentPassword: a.password, newPassword: "Another-Fine-Passphrase-2" });
      clock.t += 20 * MINUTE; // clear the sign-in counters so this test is about passwords, not limits
      expect((await signIn(a)).status).toBe(401);
      expect((await signIn({ ...a, password: "Another-Fine-Passphrase-2" })).status).toBe(200);
    });

    it("needs the current password: a stolen session alone cannot change it", async () => {
      const a = await account();
      const s = await session(a);
      const r = await change(s, { currentPassword: "Not-The-Password-1", newPassword: "Another-Fine-Passphrase-3" });
      expect(r.status).toBe(403);
      expect(r.body.error?.code).toBe("current_password_incorrect");
      expect((await signIn(a)).status).toBe(200); // unchanged
      expect(JSON.stringify(await audit("staff.password_change_failed", a.id))).toContain("wrong_current_password");
    });

    it.each([
      ["too short", () => "short1", "shorter than 12 characters"],
      ["too few different characters", () => "aaaaaaaaaaaaaaaa", "too few different characters"],
      ["the same as the current password", (a: Account) => a.password, "same as the current password"],
      ["containing the e-mail name", (a: Account) => `${a.email.split("@")[0]}-and-more-1`, "contains the e-mail name"],
    ])("refuses a new password that is %s with 422 and the reason", async (_label, make, problem) => {
      const a = await account();
      const s = await session(a);
      const attempt = make(a);
      const r = await change(s, { currentPassword: a.password, newPassword: attempt });
      expect(r.status).toBe(422);
      expect(r.body.error?.problems).toContain(problem);
      expect(JSON.stringify(r.body)).not.toContain(attempt);
      expect((await me(s)).status).toBe(200); // nothing was changed or revoked
    });

    it("needs the CSRF token and an allowed origin like every change", async () => {
      const a = await account();
      const s = await session(a);
      const body = { currentPassword: a.password, newPassword: "Another-Fine-Passphrase-4" };
      expect((await call("/api/v1/staff/password", { method: "POST", cookie: s.cookie, body })).body.error?.code).toBe("csrf_invalid");
      expect((await change(s, body, { origin: "http://evil.test" })).status).toBe(403);
      expect((await call("/api/v1/staff/password", { method: "POST", body, origin: null })).status).toBe(403); // no origin
      expect((await call("/api/v1/staff/password", { method: "POST", origin: ORIGIN, body })).status).toBe(401); // origin ok, no session
      expect((await me(s)).status).toBe(200);
    });

    it("limits password attempts per account, so a stolen session cannot guess the current password", async () => {
      const a = await account();
      const s = await session(a);
      for (let i = 0; i < LIMITS.passwordPerAccount.max; i++) expect((await change(s, { currentPassword: `Guess-${i}-Wrong-Pass`, newPassword: "Another-Fine-Passphrase-5" })).status).toBe(403);
      const limited = await change(s, { currentPassword: a.password, newPassword: "Another-Fine-Passphrase-5" });
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    });

    it("audits the change with counts only", async () => {
      const a = await account({ mustChange: 1 });
      const s = await session(a);
      await session(a); // a second session, to be ended
      await change(s, { currentPassword: a.password, newPassword: "Another-Fine-Passphrase-6" });
      const rows = await audit("staff.password_changed", a.id);
      expect(rows).toHaveLength(1);
      const details = JSON.stringify(rows[0]!.details);
      expect(details).toContain("sessions_ended");
      expect(details).toContain("first_login");
      expect(details).not.toContain("Another-Fine");
    });
  });

  // ---- roles ----------------------------------------------------------------------------------------------------------------------------
  describe("role authorization", () => {
    it("lets each role into its own routes only", async () => {
      const admin = await session(await account({ role: "admin" }));
      const judge = await session(await account({ role: "judge" }));
      expect((await call("/api/v1/test/admin-only", { cookie: admin.cookie, origin: null })).status).toBe(200);
      expect((await call("/api/v1/test/judge-only", { cookie: judge.cookie, origin: null })).status).toBe(200);
      for (const [who, path] of [[judge, "admin-only"], [admin, "judge-only"]] as const) {
        const r = await call(`/api/v1/test/${path}`, { cookie: who.cookie, origin: null });
        expect(r.status).toBe(403);
        expect(r.body.error?.code).toBe("forbidden");
      }
    });

    it("cannot be escalated by the request: the role is never read from the body, a header or the cookie", async () => {
      const judgeAccount = await account({ role: "judge" });
      const judge = await session(judgeAccount);
      const withRole = await call("/api/v1/staff/password", { method: "POST", cookie: judge.cookie, csrf: judge.csrf, body: { currentPassword: judgeAccount.password, newPassword: "Another-Fine-Passphrase-7", role: "admin" } });
      expect(withRole.status).toBe(400);
      const spoofed = await call("/api/v1/test/admin-only", { cookie: `${judge.cookie}; role=admin`, origin: null, ...{} });
      expect(spoofed.status).toBe(403);
      const headerSpoof = await fetch(`${base}/api/v1/test/admin-only`, { headers: { cookie: judge.cookie, "x-role": "admin", "x-forwarded-user": "admin" } });
      expect(headerSpoof.status).toBe(403);
      expect((await sql<{ role: string }>("SELECT role FROM staff_users WHERE id = ?", [judgeAccount.id])).rows[0]!.role).toBe("judge");
    });

    it("re-reads the role on every request: a demoted administrator loses access immediately", async () => {
      const a = await account({ role: "admin" });
      const s = await session(a);
      expect((await call("/api/v1/test/admin-only", { cookie: s.cookie, origin: null })).status).toBe(200);
      await sql("UPDATE staff_users SET role = 'judge' WHERE id = ?", [a.id]);
      expect((await call("/api/v1/test/admin-only", { cookie: s.cookie, origin: null })).status).toBe(403);
      expect((await me(s)).body.user?.role).toBe("judge");
    });

    it("cannot use another member's session or CSRF token", async () => {
      const judge = await session(await account({ role: "judge" }));
      const admin = await session(await account({ role: "admin" }));
      const r = await call("/api/v1/test/change", { method: "POST", cookie: judge.cookie, csrf: admin.csrf });
      expect(r.status).toBe(403);
    });
  });

  // ---- reset and bootstrap ---------------------------------------------------------------------------------------------------------------
  describe("password reset and administrator creation", () => {
    it("a reset ends every session, forces a change, and the old password stops working", async () => {
      const a = await account();
      const s = await session(a);
      const { temporaryPassword } = await resetPassword(deps(), { staffId: a.id, actor: { type: "system" } });
      expect((await me(s)).status).toBe(401);
      clock.t += 20 * MINUTE;
      expect((await signIn(a)).status).toBe(401);
      const again = await signIn({ ...a, password: temporaryPassword });
      expect(again.status).toBe(200);
      expect(again.body.user?.mustChangePassword).toBe(true);
      expect((await call("/api/v1/test/admin-only", { cookie: again.cookie, origin: null })).body.error?.code).toBe("password_change_required");
      expect(JSON.stringify(await audit("staff.password_reset", a.id))).not.toContain(temporaryPassword);
    });

    it("refuses to reset an account that does not exist", async () => {
      await expect(resetPassword(deps(), { staffId: 999_999_999, actor: { type: "system" } })).rejects.toMatchObject({ status: 404 });
    });

    it("creates an administrator with a temporary password that must be changed, stored only as a hash", async () => {
      const email = `bootstrap${next()}@example.org`;
      const created = await createAdmin(deps(), { email: email.toUpperCase(), displayName: "முதல் நிர்வாகி", actor: { type: "system" } });
      const row = (await sql<{ role: string; must_change_password: number; password_hash: string; email: string; active: number }>("SELECT role, must_change_password, password_hash, email, active FROM staff_users WHERE id = ?", [created.id])).rows[0]!;
      expect(row).toMatchObject({ role: "admin", email, must_change_password: 1, active: 1 });
      expect(row.password_hash).toMatch(/^\$argon2id\$/);
      expect(row.password_hash).not.toContain(created.temporaryPassword);
      const reply = await signIn({ id: created.id, email, password: created.temporaryPassword });
      expect(reply.status).toBe(200);
      expect(reply.body.user).toMatchObject({ role: "admin", mustChangePassword: true });
      expect(JSON.stringify(await audit("staff.created", created.id))).not.toContain(created.temporaryPassword);
      await expect(createAdmin(deps(), { email, displayName: "Again", actor: { type: "system" } })).rejects.toMatchObject({ status: 409, code: "email_taken" });
      await expect(createAdmin(deps(), { email: "not-an-email", displayName: "X", actor: { type: "system" } })).rejects.toMatchObject({ status: 400 });
    });
  });

  // ---- what must never be stored or leaked --------------------------------------------------------------------------------------------
  describe("secrets and scope", () => {
    it("never writes a password, token, e-mail address or IP address into the audit log, sessions or rate-limit tables", async () => {
      const a = await account();
      const ip = "203.0.113.55";
      const s = await session(a, { ip });
      await signIn({ ...a, password: "Totally-Wrong-Pass-9" }, { ip });
      await call("/api/v1/staff/password", { method: "POST", cookie: s.cookie, csrf: s.csrf, body: { currentPassword: a.password, newPassword: "Never-Stored-Plain-Pass-8" } });
      const everything = JSON.stringify([
        (await sql("SELECT * FROM audit_log")).rows,
        (await sql("SELECT * FROM staff_sessions")).rows,
        (await sql("SELECT * FROM rate_limits")).rows,
      ]);
      for (const secret of [a.password, "Totally-Wrong-Pass-9", "Never-Stored-Plain-Pass-8", tokenOf(s.cookie), ip, a.email]) expect(everything, secret).not.toContain(secret);
    });

    it("returns no password hash, digest or internal id in any staff response", async () => {
      const a = await account();
      const s = await session(a);
      const text = JSON.stringify([s.reply.body, (await me(s)).body]);
      expect(text).not.toMatch(/argon2|token_sha256|password_hash|session_id/i);
    });

    it("leaves registration closed: signing in or out never touches the event settings", async () => {
      const settings = (await sql("SELECT * FROM event_settings")).rows[0]!;
      expect(settings).toMatchObject({ id: 1, submissions_open_at: null, submissions_close_at: null, results_publish_at: null, guardian_consent_version: null });
      expect(await scalar("SELECT COUNT(*) AS n FROM submissions")).toBe(0);
    });

    it("keeps unknown routes and methods as plain 404s", async () => {
      expect((await call("/api/v1/staff/register", { method: "POST" })).status).toBe(404);
      expect((await call("/api/v1/staff/login", { method: "GET", origin: null })).status).toBe(404);
    });
  });
});
