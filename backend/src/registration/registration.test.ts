import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { hashPassword } from "../auth/password.ts";
import { sha256Hex } from "../auth/tokens.ts";
import type { DatabaseAdapter, Dialect } from "../db/adapter.ts";
import { dialects, openTestDatabase } from "../db/test-db.ts";
import { dropAppSchema, installAppSchema } from "../db/test-schema.ts";
import { captureLogger, listen, testConfig } from "../test-helpers.ts";
import { canonicalCode } from "./codes.ts";
import { REGISTRATION_LIMITS } from "./service.ts";

// The public registration API end to end: real HTTP, the real app, the real database (MySQL 8 when configured, SQLite always). Time is a
// variable, so the registration window, code expiry and rate-limit windows are tested without sleeping.

const SITE = "http://site.test";
const ADMIN = "http://admin.test";
const TRACKING = "zz_registration_migrations";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OPTIONS = JSON.stringify([{ code: "a", ta: "அ", en: "A" }, { code: "b", ta: "ஆ", en: "B" }, { code: "c", ta: "இ", en: "C" }]);
const COMPOSED = "கொ";
const DECOMPOSED = "கொ";

type Question = { key: string; type: string; required: boolean; options: { code: string }[] | null };
type View = {
  reference: string; status: string; editable: boolean;
  event: { slug: string; nameTa: string; nameEn: string; minAge: number; maxAge: number };
  child: { name: string; age: number };
  guardian: { name: string; mobile: string; email: string | null };
  consent: { guardian: { version: string | null; at: string | null }; media: { granted: boolean | null; version: string | null; at: string | null } };
  questionSet: { version: number; questions: Question[] };
  answers: Record<string, unknown>;
  missingRequired: string[];
  codeExpiresAt: string;
};
type Body = {
  reference?: string; recoveryCode?: string; csrfToken?: string; registration?: View;
  events?: { slug: string; nameTa: string; minAge: number; maxAge: number; questionSet: { version: number; questions: Question[] } | null }[];
  registrationOpen?: boolean; opensAt?: string | null; closesAt?: string | null; guardianConsentVersion?: string | null; mediaConsentVersion?: string | null; serverTime?: string;
  error?: { code: string; message: string; requestId: string; fields?: { field: string; problem: string }[] };
  user?: { role: string };
};
type Reply = { status: number; body: Body; text: string; headers: Headers; cookie: string | null; setCookie: string | null };
type Session = { cookie: string; csrf: string; code: string; reference: string; reply: Reply };

describe.each(dialects)("%s anonymous registration", (dialect: Dialect) => {
  let db: DatabaseAdapter;
  let servers: Server[] = [];
  let base: string;
  const clock = { t: Date.now() };
  const now = () => new Date(clock.t);
  const log = captureLogger();
  const config = testConfig({ ALLOWED_ORIGINS: ADMIN, PUBLIC_ORIGINS: SITE, TRUST_PROXY_HOPS: "1", ARGON2_MEMORY_KIB: "1024", ARGON2_PASSES: "1" });

  async function start(): Promise<string> {
    const server = createServer(createApp({ config, logger: log.logger, state: { shuttingDown: false }, db, now }));
    servers.push(server);
    return listen(server);
  }

  let counter = 0;
  const next = () => ++counter;
  const freshIp = () => `10.${Math.floor(next() / 250) % 250}.${counter % 250}.${(counter * 7) % 250}`;
  const mobile = () => `9${String(10_000_000 + next()).padStart(9, "0")}`;
  const sql = <Row = Record<string, unknown>>(text: string, params: readonly (string | number | Date | null)[] = []) => db.query<Row>(text, params);
  const scalar = async (text: string, params: readonly (string | number | Date | null)[] = []) => Number((await sql<{ n: number }>(text, params)).rows[0]!.n);

  // ---- world -------------------------------------------------------------------------------------------------------------------------
  const ids: Record<string, number> = {};
  async function addEvent(slug: string, min: number, max: number, active = 1): Promise<number> {
    await sql("INSERT INTO events (slug, name_ta, name_en, min_age, max_age, active, display_order) VALUES (?, ?, ?, ?, ?, ?, ?)", [slug, `போட்டி ${slug}`, `Contest ${slug}`, min, max, active, next()]);
    return Number((await sql<{ id: number }>("SELECT id FROM events WHERE slug = ?", [slug])).rows[0]!.id);
  }
  async function publishSet(eventId: number, version: number, withQuestions: boolean): Promise<number> {
    await sql("INSERT INTO question_sets (event_id, version) VALUES (?, ?)", [eventId, version]);
    const setId = Number((await sql<{ id: number }>("SELECT id FROM question_sets WHERE event_id = ? AND version = ?", [eventId, version])).rows[0]!.id);
    if (withQuestions) {
      const rows: [string, string, number, string | null, number, string | null, number | null, number | null, number | null][] = [
        ["school", "short_text", 1, null, 1, null, 40, null, null],
        ["about", "paragraph", 2, null, 0, null, null, null, null],
        ["group", "dropdown", 3, OPTIONS, 0, null, null, null, null],
        ["level", "radio", 4, OPTIONS, 0, null, null, null, null],
        ["hobbies", "checkboxes", 5, OPTIONS, 0, null, null, null, null],
        ["siblings", "number", 6, null, 0, null, null, 0, 10],
        ["note", "instruction", 7, null, 0, null, null, null, null],
      ];
      for (const [key, type, position, options, required, , maxLength, min, max] of rows) {
        await sql(
          "INSERT INTO questions (question_set_id, position, question_key, type, prompt_ta, prompt_en, help_en, required, options_json, max_length, min_number, max_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [setId, position, key, type, `கேள்வி ${key}`, `Question ${key}`, "Some help", required, options, maxLength, min, max],
        );
      }
    }
    await sql("UPDATE question_sets SET status = 'published', published_at = ? WHERE id = ?", [now(), setId]);
    return setId;
  }
  async function openRegistration(over: { open?: number; close?: number; guardian?: string | null; media?: string | null } = {}) {
    await sql("UPDATE event_settings SET submissions_open_at = ?, submissions_close_at = ?, guardian_consent_version = ?, media_consent_version = ? WHERE id = 1", [
      new Date(clock.t + (over.open ?? -HOUR)), new Date(clock.t + (over.close ?? 60 * DAY)), over.guardian === undefined ? "v1" : over.guardian, over.media === undefined ? "m1" : over.media,
    ]);
  }
  const closeRegistration = () => sql("UPDATE event_settings SET submissions_open_at = NULL, submissions_close_at = NULL, results_publish_at = NULL, guardian_consent_version = NULL, media_consent_version = NULL WHERE id = 1");

  beforeAll(async () => {
    db = openTestDatabase(dialect);
    await installAppSchema(db, TRACKING);
    ids.main = await addEvent("malalai-mozhi", 3, 12);
    ids.mainSet = await publishSet(ids.main, 1, true);
    ids.small = await addEvent("kathai-sollum", 5, 8);
    ids.smallSet = await publishSet(ids.small, 1, false);
    ids.hidden = await addEvent("hidden-contest", 3, 12, 0);
    await publishSet(ids.hidden, 1, false);
    ids.noSet = await addEvent("no-question-set", 3, 12);
    base = await start();
  }, 120_000);
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((resolve) => (s.closeAllConnections(), s.close(resolve)))));
    servers = [];
    await dropAppSchema(db, TRACKING);
    await db.close();
  });
  beforeEach(openRegistration);

  // ---- requests ------------------------------------------------------------------------------------------------------------------------
  type Options = { method?: string; body?: unknown; raw?: string; cookie?: string | null; origin?: string | null; csrf?: string | null; ip?: string; baseUrl?: string; contentType?: string | null };
  async function call(path: string, o: Options = {}): Promise<Reply> {
    const method = o.method ?? "GET";
    const sends = method !== "GET";
    const headers: Record<string, string> = { "x-forwarded-for": o.ip ?? freshIp() };
    if (sends && o.contentType !== null) headers["content-type"] = o.contentType ?? "application/json";
    if (o.origin !== null && (sends || o.origin !== undefined)) headers.origin = o.origin ?? SITE;
    if (o.cookie) headers.cookie = o.cookie;
    if (o.csrf) headers["x-csrf-token"] = o.csrf;
    const res = await fetch((o.baseUrl ?? base) + path, { method, headers, ...(sends ? { body: o.raw ?? JSON.stringify(o.body ?? {}) } : {}) });
    const text = await res.text();
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("rio_reg=")) ?? null;
    return { status: res.status, body: text ? (JSON.parse(text) as Body) : {}, text, headers: res.headers, cookie: setCookie && !setCookie.startsWith("rio_reg=;") ? setCookie.split(";")[0]! : null, setCookie };
  }
  const defaults = () => ({ eventSlug: "malalai-mozhi", childName: "Asha Kumar", childAge: 6, guardianName: "Priya Kumar", guardianMobile: mobile(), guardianConsent: { accepted: true, version: "v1" } });
  const create = (over: Record<string, unknown> = {}, o: Options = {}) => call("/api/v1/registrations", { method: "POST", body: { ...defaults(), ...over }, ...o });
  async function register(over: Record<string, unknown> = {}, o: Options = {}): Promise<Session> {
    const reply = await create(over, o);
    expect(reply.status, JSON.stringify(reply.body.error)).toBe(201);
    return { cookie: reply.cookie!, csrf: reply.body.csrfToken!, code: reply.body.recoveryCode!, reference: reply.body.reference!, reply };
  }
  const current = (s: { cookie: string | null }, o: Options = {}) => call("/api/v1/registrations/current", { cookie: s.cookie, origin: null, ...o });
  const patch = (s: { cookie: string; csrf: string }, body: unknown, o: Options = {}) => call("/api/v1/registrations/current", { method: "PATCH", cookie: s.cookie, csrf: s.csrf, body, ...o });
  const recoverWith = (code: string, o: Options = {}) => call("/api/v1/registrations/recover", { method: "POST", body: { code }, ...o });
  const row = async (reference: string) =>
    (await sql<Record<string, unknown>>("SELECT * FROM submissions WHERE entry_code = ?", [reference])).rows[0]!;
  const idOf = async (reference: string) => Number((await row(reference)).id);

  async function finalizeEntry(submissionId: number, status: "finalized" | "held" = "finalized") {
    await sql("INSERT INTO video_uploads (submission_id, object_key, content_type, declared_bytes, status, expires_at, verified_at, verified_bytes) VALUES (?, ?, 'video/mp4', 200000, 'verified', ?, ?, 200000)", [submissionId, randomUUID(), new Date(clock.t + HOUR), now()]);
    await sql(`UPDATE submissions SET status = ?, submitted_at = ?${status === "finalized" ? ", finalized_at = ?" : ""} WHERE id = ?`, status === "finalized" ? [status, now(), now(), submissionId] : [status, now(), submissionId]);
  }
  const dump = async () =>
    JSON.stringify([
      (await sql("SELECT * FROM audit_log")).rows, (await sql("SELECT * FROM rate_limits")).rows, (await sql("SELECT * FROM registration_recovery")).rows, (await sql("SELECT * FROM staff_sessions")).rows,
    ]);

  // ---- public information --------------------------------------------------------------------------------------------------------------
  describe("registration stays closed until an administrator opens it", () => {
    it("is closed by default: the settings row starts empty and nothing can be created", async () => {
      await closeRegistration();
      const settings = await call("/api/v1/settings/public");
      expect(settings.status).toBe(200);
      expect(settings.body).toMatchObject({ registrationOpen: false, opensAt: null, closesAt: null, guardianConsentVersion: null, mediaConsentVersion: null });
      const before = await scalar("SELECT COUNT(*) AS n FROM submissions");
      const r = await create();
      expect(r.status).toBe(403);
      expect(r.body.error?.code).toBe("registration_closed");
      expect(r.cookie).toBeNull();
      expect(await scalar("SELECT COUNT(*) AS n FROM submissions")).toBe(before);
    });

    it.each([
      ["before the window opens", { open: HOUR, close: 2 * HOUR }],
      ["after the window closes", { open: -2 * HOUR, close: -HOUR }],
    ])("is closed %s", async (_label, over) => {
      await openRegistration(over);
      expect((await call("/api/v1/settings/public")).body.registrationOpen).toBe(false);
      expect((await create()).body.error?.code).toBe("registration_closed");
    });

    it("cannot even be configured as open without a consent version: the database refuses it", async () => {
      await closeRegistration();
      await expect(openRegistration({ guardian: null })).rejects.toMatchObject({ kind: "constraint", constraint: "check" });
      expect((await call("/api/v1/settings/public")).body.registrationOpen).toBe(false);
    });

    it("opens exactly inside the window and follows the clock", async () => {
      await openRegistration({ open: HOUR, close: 3 * HOUR });
      expect((await call("/api/v1/settings/public")).body.registrationOpen).toBe(false);
      clock.t += 90 * 60_000;
      expect((await call("/api/v1/settings/public")).body.registrationOpen).toBe(true);
      expect((await create()).status).toBe(201);
      clock.t += 2 * HOUR;
      expect((await call("/api/v1/settings/public")).body.registrationOpen).toBe(false);
      expect((await create()).status).toBe(403);
    });

    it("publishes the window and consent versions but never any consent wording", async () => {
      const s = await call("/api/v1/settings/public");
      expect(s.body).toMatchObject({ registrationOpen: true, guardianConsentVersion: "v1", mediaConsentVersion: "m1" });
      expect(new Date(s.body.serverTime!).getTime()).toBe(clock.t);
      expect(Object.keys(s.body).sort()).toEqual(["closesAt", "guardianConsentVersion", "mediaConsentVersion", "opensAt", "registrationOpen", "serverTime"]);
    });
  });

  describe("GET /api/v1/events", () => {
    it("lists the active competitions with their bilingual published questions and nothing internal", async () => {
      const r = await call("/api/v1/events");
      expect(r.status).toBe(200);
      const slugs = r.body.events!.map((e) => e.slug);
      expect(slugs).toEqual(expect.arrayContaining(["malalai-mozhi", "kathai-sollum", "no-question-set"]));
      expect(slugs).not.toContain("hidden-contest");
      const main = r.body.events!.find((e) => e.slug === "malalai-mozhi")!;
      expect(main).toMatchObject({ minAge: 3, maxAge: 12, nameTa: "போட்டி malalai-mozhi" });
      expect(main.questionSet!.questions.map((q) => q.type)).toEqual(["short_text", "paragraph", "dropdown", "radio", "checkboxes", "number", "instruction"]);
      expect(main.questionSet!.questions[2]!.options).toEqual([{ code: "a", ta: "அ", en: "A" }, { code: "b", ta: "ஆ", en: "B" }, { code: "c", ta: "இ", en: "C" }]);
      expect(r.body.events!.find((e) => e.slug === "no-question-set")!.questionSet).toBeNull();
      expect(r.text).not.toMatch(/"id"|created_by|published_by|status/);
    });

    it("is readable from the public site's origin and the admin's, and from no other", async () => {
      expect((await call("/api/v1/events", { origin: SITE })).headers.get("access-control-allow-origin")).toBe(SITE);
      expect((await call("/api/v1/events", { origin: ADMIN })).headers.get("access-control-allow-origin")).toBe(ADMIN);
      expect((await call("/api/v1/events", { origin: "http://evil.test" })).headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  // ---- create --------------------------------------------------------------------------------------------------------------------------
  describe("POST /api/v1/registrations", () => {
    it("creates a draft with no account: a reference, a recovery code, an HttpOnly cookie and the entry back", async () => {
      const r = await create({ guardianEmail: "Parent@Example.ORG " });
      expect(r.status).toBe(201);
      expect(r.body.reference).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
      expect(r.body.recoveryCode).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(r.body.csrfToken).toBeTruthy();
      const view = r.body.registration!;
      expect(view).toMatchObject({
        reference: r.body.reference, status: "draft", editable: true,
        event: { slug: "malalai-mozhi", minAge: 3, maxAge: 12 },
        child: { name: "Asha Kumar", age: 6 },
        guardian: { name: "Priya Kumar", email: "parent@example.org" },
        consent: { guardian: { version: "v1" }, media: { granted: null, version: null, at: null } },
        questionSet: { version: 1 }, answers: {}, missingRequired: ["school"],
      });
      expect(view.guardian.mobile).toMatch(/^\+919\d{9}$/);
      expect(view.consent.guardian.at).toBe(now().toISOString());
      expect(new Date(view.codeExpiresAt).getTime()).toBe(clock.t + 30 * DAY);
      const cookie = r.setCookie!;
      expect(cookie).toMatch(/; HttpOnly/);
      expect(cookie).toMatch(/; Path=\//);
      expect(cookie).toMatch(/; SameSite=Strict/);
      expect(cookie).toMatch(/Max-Age=2592000/);
      expect(cookie).not.toMatch(/Domain=/i);
      expect(canonicalCode(cookie.split(";")[0]!.slice("rio_reg=".length))).toBe(canonicalCode(r.body.recoveryCode!));
    });

    it("binds the entry to the competition's published question set and records the guardian consent version and time", async () => {
      const s = await register();
      const e = await row(s.reference);
      expect(Number(e.event_id)).toBe(ids.main);
      expect(Number(e.question_set_id)).toBe(ids.mainSet);
      expect(e).toMatchObject({ status: "draft", guardian_consent_version: "v1", media_consent: null, media_consent_version: null });
      expect(s.reply.body.registration!.questionSet.questions.map((q) => q.key)).toEqual(["school", "about", "group", "level", "hobbies", "siblings", "note"]);
    });

    it("keeps only a SHA-256 digest of the recovery code, and the code appears nowhere else", async () => {
      const s = await register();
      const code = canonicalCode(s.code)!;
      const rows = (await sql<{ token_sha256: string; expires_at: unknown; used_at: unknown; revoked_at: unknown }>("SELECT token_sha256, expires_at, used_at, revoked_at FROM registration_recovery WHERE submission_id = ?", [await idOf(s.reference)])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.token_sha256).toBe(sha256Hex(code));
      expect(rows[0]!.used_at).toBeNull();
      const everything = (await dump()) + JSON.stringify((await sql("SELECT * FROM submissions")).rows);
      expect(everything).not.toContain(code);
      expect(everything).not.toContain(s.code);
    });

    it("stores Tamil exactly, normalised to NFC, and keeps a lower-cased key for matching", async () => {
      const s = await register({ childName: `  கீர்த்தனா   ${DECOMPOSED} `, guardianName: "ஸ்ரீ ப்ரியா" });
      const e = await row(s.reference);
      expect(e.child_name).toBe(`கீர்த்தனா ${COMPOSED}`);
      expect(e.child_name_norm).toBe(`கீர்த்தனா ${COMPOSED}`);
      expect(e.guardian_name).toBe("ஸ்ரீ ப்ரியா");
      const mixed = await register({ childName: "Mary-Ann O’Neil" });
      expect((await row(mixed.reference)).child_name_norm).toBe("mary ann o neil");
    });

    it.each([
      ["9876543210"], ["09876543210"], ["+919876543210"], ["+91 98765 43210"], ["98765-43210"], ["௯௮௭௬௫௪௩௨௧௦"],
    ])("stores the mobile number %j as +919876543210", async (typed) => {
      const ip = freshIp();
      const r = await create({ guardianMobile: typed }, { ip });
      expect(r.status).toBe(201);
      expect(r.body.registration!.guardian.mobile).toBe("+919876543210");
    });

    it("treats the e-mail address as optional: absent, null and empty are all 'none'", async () => {
      for (const email of [undefined, null, "", "   "]) {
        const r = await create(email === undefined ? {} : { guardianEmail: email });
        expect(r.status).toBe(201);
        expect(r.body.registration!.guardian.email).toBeNull();
      }
      expect((await create({ guardianEmail: "not-an-email" })).body.error?.fields).toEqual([{ field: "guardianEmail", problem: "invalid_email" }]);
    });

    it("records guardian consent as mandatory and media consent as separate and optional", async () => {
      const none = await register();
      expect((await row(none.reference)).media_consent).toBeNull(); // never asked
      const yes = await register({ mediaConsent: { granted: true, version: "m1" } });
      expect(yes.reply.body.registration!.consent.media).toMatchObject({ granted: true, version: "m1", at: now().toISOString() });
      const no = await register({ mediaConsent: { granted: false, version: "m1" } });
      expect(no.reply.body.registration!.consent.media).toMatchObject({ granted: false, version: "m1" }); // declined is not the same as never asked
      expect(Number((await row(no.reference)).media_consent)).toBe(0);
      expect((await row(no.reference)).guardian_consent_version).toBe("v1");
    });

    it("refuses an entry without the guardian's consent, or with consent to other wording, and creates nothing", async () => {
      const before = await scalar("SELECT COUNT(*) AS n FROM submissions");
      const without: Record<string, unknown> = defaults();
      delete without.guardianConsent;
      const missing = await call("/api/v1/registrations", { method: "POST", body: without });
      expect(missing.status).toBe(422);
      expect(missing.body.error?.fields).toContainEqual({ field: "guardianConsent", problem: "invalid_type" });
      const declined = await create({ guardianConsent: { accepted: false, version: "v1" } });
      expect(declined.status).toBe(422);
      expect(declined.body.error?.fields).toContainEqual({ field: "guardianConsent.accepted", problem: "consent_required" });
      expect((await create({ guardianConsent: { accepted: true } })).status).toBe(422);
      expect((await create({ guardianConsent: true })).status).toBe(422);
      const stale = await create({ guardianConsent: { accepted: true, version: "v0" } });
      expect(stale.status).toBe(409);
      expect(stale.body.error?.code).toBe("consent_version_changed");
      expect(await scalar("SELECT COUNT(*) AS n FROM submissions")).toBe(before);
    });

    it("refuses media consent when no media wording is offered, or for other wording", async () => {
      await openRegistration({ media: null });
      const notOffered = await create({ mediaConsent: { granted: true, version: "m1" } });
      expect(notOffered.status).toBe(422);
      expect(notOffered.body.error?.fields).toEqual([{ field: "mediaConsent", problem: "media_consent_not_offered" }]);
      expect((await create()).status).toBe(201); // and registering without it still works
      await openRegistration();
      expect((await create({ mediaConsent: { granted: true, version: "m0" } })).body.error?.code).toBe("consent_version_changed");
    });

    it.each([
      ["below the competition's range", { childAge: 2 }],
      ["above the competition's range", { childAge: 13 }],
      ["zero", { childAge: 0 }],
      ["negative", { childAge: -1 }],
      ["nineteen", { childAge: 19 }],
      ["fractional", { childAge: 6.5 }],
      ["a string", { childAge: "6" }],
      ["null", { childAge: null }],
      ["not a number", { childAge: Number.NaN }],
    ])("refuses a child age that is %s", async (_label, over) => {
      const r = await create(over);
      expect(r.status).toBe(422);
      expect(r.body.error?.fields?.[0]?.field).toBe("childAge");
    });

    it("applies each competition's own age range", async () => {
      expect((await create({ eventSlug: "kathai-sollum", childAge: 5 })).status).toBe(201);
      expect((await create({ eventSlug: "kathai-sollum", childAge: 8 })).status).toBe(201);
      const r = await create({ eventSlug: "kathai-sollum", childAge: 9 });
      expect(r.status).toBe(422);
      expect(r.body.error?.fields).toEqual([{ field: "childAge", problem: "out_of_range" }]);
      expect((await create({ eventSlug: "malalai-mozhi", childAge: 9 })).status).toBe(201);
    });

    it.each([
      ["a number that is too short", "98765"],
      ["a number starting with 5", "5876543210"],
      ["a foreign number", "+449876543210"],
      ["letters", "98765abcde"],
      ["a SQL fragment", "9876543210'; DROP TABLE submissions; --"],
      ["an empty value", ""],
      ["two numbers", "9876543210 9876543211"],
    ])("refuses a mobile number that is %s without echoing it", async (_label, typed) => {
      const r = await create({ guardianMobile: typed });
      expect(r.status).toBe(422);
      expect(r.body.error?.fields).toEqual([{ field: "guardianMobile", problem: "invalid_mobile" }]);
      if (typed.length > 4) expect(r.text).not.toContain(typed);
    });

    it.each([
      ["digits", "Asha2"], ["markup", "<b>Asha</b>"], ["an emoji", "Asha 😀"], ["only spaces", "     "], ["an empty name", ""], ["81 characters", "அ".repeat(81)], ["a leading hyphen", "-Asha"], ["a stray vowel sign", "ொ"],
    ])("refuses a child name with %s", async (_label, name) => {
      const r = await create({ childName: name });
      expect(r.status).toBe(422);
      expect(r.body.error?.fields?.[0]).toMatchObject({ field: "childName" });
    });

    it("refuses an unknown, hidden or question-less competition", async () => {
      expect((await create({ eventSlug: "does-not-exist" })).body.error?.code).toBe("event_not_found");
      expect((await create({ eventSlug: "hidden-contest" })).status).toBe(404);
      const noSet = await create({ eventSlug: "no-question-set" });
      expect(noSet.status).toBe(409);
      expect(noSet.body.error?.code).toBe("competition_unavailable");
      expect((await create({ eventSlug: "../etc/passwd" })).status).toBe(422);
    });

    it("accepts only the documented fields: status, ids, references and consent times cannot be supplied", async () => {
      for (const extra of [{ status: "finalized" }, { eventId: 1 }, { entryCode: "AAAAAAAAAA" }, { questionSetId: 1 }, { guardianConsentAt: "2020-01-01" }, { role: "admin" }, { childNameNorm: "x" }]) {
        const r = await create(extra);
        expect(r.status, JSON.stringify(extra)).toBe(422);
        expect(r.body.error?.fields?.[0]?.problem).toBe("unrecognized_keys");
      }
    });

    it("answers a missing or malformed body with a clean error", async () => {
      expect((await call("/api/v1/registrations", { method: "POST", raw: "{broken" })).status).toBe(400);
      expect((await call("/api/v1/registrations", { method: "POST", raw: "[1,2]" })).status).toBe(422);
      expect((await call("/api/v1/registrations", { method: "POST", raw: "name=x", contentType: "application/x-www-form-urlencoded" })).status).toBe(422);
    });

    it("needs an Origin from the public site: nobody else, and no Origin at all, can register", async () => {
      const before = await scalar("SELECT COUNT(*) AS n FROM submissions");
      for (const origin of ["http://evil.test", ADMIN, "http://site.test.evil.test", "https://site.test", "null"]) expect((await create({}, { origin })).status, origin).toBe(403);
      const none = await create({}, { origin: null });
      expect(none.status).toBe(403);
      expect(none.body.error?.code).toBe("origin_not_allowed");
      expect(await scalar("SELECT COUNT(*) AS n FROM submissions")).toBe(before);
    });

    it("gives the same kind of answer for a brand-new child and for one who already has a submitted entry", async () => {
      const first = await register({ childName: "Unique Kid", guardianMobile: "9000000001" });
      await finalizeEntry(await idOf(first.reference));
      const again = await create({ childName: "Unique Kid", guardianMobile: "9000000001" });
      const fresh = await create({ childName: "Another Kid", guardianMobile: "9000000002" });
      expect(again.status).toBe(201);
      expect(Object.keys(again.body).sort()).toEqual(Object.keys(fresh.body).sort());
      expect(Object.keys(again.body.registration!).sort()).toEqual(Object.keys(fresh.body.registration!).sort());
      expect(again.text).not.toMatch(/duplicate|already|exists|flag/i);
    });
  });

  // ---- duplicates ----------------------------------------------------------------------------------------------------------------------
  describe("duplicate matching", () => {
    const reviewsFor = async (reference: string) => (await sql<{ status: string; reason: string; matched: number | string }>("SELECT status, reason, matched_submission_id AS matched FROM duplicate_reviews WHERE submission_id = ?", [await idOf(reference)])).rows;

    it("flags (never blocks) a second entry for the same normalised child, mobile and competition, against the finalized one", async () => {
      const first = await register({ childName: "Asha Kumar", guardianMobile: "9111111111" });
      const firstId = await idOf(first.reference);
      expect(await reviewsFor(first.reference)).toHaveLength(0);
      await finalizeEntry(firstId);
      const second = await register({ childName: "Asha Kumar", guardianMobile: "9111111111" });
      const reviews = await reviewsFor(second.reference);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({ status: "flagged", reason: "same_child_mobile_event" });
      expect(Number(reviews[0]!.matched)).toBe(firstId);
      expect(await scalar("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'registration.duplicate_flagged' AND entity_id = ?", [String(await idOf(second.reference))])).toBe(1);
    });

    it.each([
      ["different capitals", "ASHA KUMAR"],
      ["extra spaces", "  Asha    Kumar "],
      ["a hyphen instead of a space", "Asha-Kumar"],
      ["a trailing full stop", "Asha Kumar."],
    ])("matches %s", async (_label, name) => {
      const mob = mobile();
      await finalizeEntry(await idOf((await register({ childName: "Asha Kumar", guardianMobile: mob })).reference));
      const second = await register({ childName: name, guardianMobile: mob });
      expect(await reviewsFor(second.reference)).toHaveLength(1);
    });

    it("matches Tamil names written with different code point orders, but not different Tamil names", async () => {
      const mob = mobile();
      await finalizeEntry(await idOf((await register({ childName: `பா${COMPOSED}`, guardianMobile: mob })).reference));
      expect(await reviewsFor((await register({ childName: `பா${DECOMPOSED}`, guardianMobile: mob })).reference)).toHaveLength(1);
      expect(await reviewsFor((await register({ childName: "பாலா", guardianMobile: mob })).reference)).toHaveLength(0);
    });

    it("allows siblings on one mobile, the same child in another competition, and the same name with another mobile", async () => {
      const mob = mobile();
      await finalizeEntry(await idOf((await register({ childName: "Asha Kumar", guardianMobile: mob })).reference));
      const sibling = await register({ childName: "Bala Kumar", guardianMobile: mob });
      const otherContest = await register({ childName: "Asha Kumar", guardianMobile: mob, eventSlug: "kathai-sollum", childAge: 6 });
      const otherMobile = await register({ childName: "Asha Kumar", guardianMobile: mobile() });
      for (const s of [sibling, otherContest, otherMobile]) expect(await reviewsFor(s.reference), s.reference).toHaveLength(0);
    });

    it("also flags against an entry that is held for review, but not against drafts, withdrawn or rejected entries", async () => {
      const mob = mobile();
      const held = await register({ childName: "Held Child", guardianMobile: mob });
      await finalizeEntry(await idOf(held.reference), "held");
      expect(await reviewsFor((await register({ childName: "Held Child", guardianMobile: mob })).reference)).toHaveLength(1);

      const mob2 = mobile();
      await register({ childName: "Draft Child", guardianMobile: mob2 });
      expect(await reviewsFor((await register({ childName: "Draft Child", guardianMobile: mob2 })).reference)).toHaveLength(0);

      const mob3 = mobile();
      const gone = await register({ childName: "Gone Child", guardianMobile: mob3 });
      await finalizeEntry(await idOf(gone.reference));
      await sql("UPDATE submissions SET status = 'withdrawn', withdrawn_at = ? WHERE entry_code = ?", [now(), gone.reference]);
      expect(await reviewsFor((await register({ childName: "Gone Child", guardianMobile: mob3 })).reference)).toHaveLength(0);
    });

    it("re-checks when a draft's name or mobile is changed to match a submitted entry, once", async () => {
      const mob = mobile();
      await finalizeEntry(await idOf((await register({ childName: "Target Child", guardianMobile: mob })).reference));
      const s = await register({ childName: "Someone Else", guardianMobile: mob });
      expect(await reviewsFor(s.reference)).toHaveLength(0);
      expect((await patch(s, { childName: "Target Child" })).status).toBe(200);
      expect(await reviewsFor(s.reference)).toHaveLength(1);
      expect((await patch(s, { childName: "target child" })).status).toBe(200);
      expect((await patch(s, { guardianName: "Another Guardian" })).status).toBe(200);
      expect(await reviewsFor(s.reference)).toHaveLength(1); // no second flag
    });

    it("leaves the database's unique key as the real guard: the flagged draft can never become a second finalized entry", async () => {
      const mob = mobile();
      await finalizeEntry(await idOf((await register({ childName: "Only One", guardianMobile: mob })).reference));
      const second = await register({ childName: "Only One", guardianMobile: mob });
      await expect(finalizeEntry(await idOf(second.reference))).rejects.toMatchObject({ kind: "constraint", constraint: "unique" });
    });

    it("handles many identical registrations at once: all succeed, each with its own reference and code, none flagged without a submitted match", async () => {
      const mob = mobile();
      const results = await Promise.all(Array.from({ length: REGISTRATION_LIMITS.createPerMobile.max }, () => create({ childName: "Twin Child", guardianMobile: mob }, { ip: freshIp() })));
      expect(results.map((r) => r.status)).toEqual(Array(results.length).fill(201));
      expect(new Set(results.map((r) => r.body.reference)).size).toBe(results.length);
      expect(new Set(results.map((r) => r.body.recoveryCode)).size).toBe(results.length);
      for (const r of results) expect(await reviewsFor(r.body.reference!)).toHaveLength(0);
      expect(await scalar("SELECT COUNT(*) AS n FROM submissions WHERE guardian_mobile = ? AND status = 'draft'", [`+91${mob}`])).toBe(results.length);
    });

    it("flags every one of several simultaneous duplicates of a submitted entry exactly once", async () => {
      const mob = mobile();
      await finalizeEntry(await idOf((await register({ childName: "Popular Child", guardianMobile: mob })).reference));
      const results = await Promise.all(Array.from({ length: 8 }, () => create({ childName: "Popular Child", guardianMobile: mob }, { ip: freshIp() })));
      const ok = results.filter((r) => r.status === 201);
      expect(ok).toHaveLength(8);
      for (const r of ok) expect(await reviewsFor(r.body.reference!)).toHaveLength(1);
      expect(results.every((r) => r.status === 201 || r.status === 429)).toBe(true);
    });
  });

  // ---- recovery and access -------------------------------------------------------------------------------------------------------------
  describe("POST /api/v1/registrations/recover and GET /current", () => {
    it("opens the entry on another device with the typed code, in any of the usual ways of writing it", async () => {
      const s = await register({ childName: "Recoverable Child" });
      const plain = canonicalCode(s.code)!;
      for (const typed of [s.code, s.code.toLowerCase(), plain, ` ${s.code.replace(/-/g, " ")} `, plain.replace(/0/g, "O").replace(/1/g, "l")]) {
        const r = await recoverWith(typed);
        expect(r.status, typed).toBe(200);
        expect(r.body.registration!.reference).toBe(s.reference);
        expect(r.body.registration!.child.name).toBe("Recoverable Child");
        expect(r.cookie).not.toBeNull();
        expect(r.setCookie).toMatch(/HttpOnly/);
      }
    });

    it("carries on from the new device: the cookie it sets reads and edits the same entry", async () => {
      const s = await register();
      const device2 = await recoverWith(s.code);
      const cookie = device2.cookie!;
      expect((await current({ cookie })).body.registration!.reference).toBe(s.reference);
      const changed = await patch({ cookie, csrf: device2.body.csrfToken! }, { childName: "Renamed On Phone" });
      expect(changed.body.registration!.child.name).toBe("Renamed On Phone");
      expect((await current(s)).body.registration!.child.name).toBe("Renamed On Phone"); // and the first device sees it
    });

    it("does not rotate the code: using it does not use it up", async () => {
      const s = await register();
      expect((await recoverWith(s.code)).status).toBe(200);
      expect((await recoverWith(s.code)).status).toBe(200);
      expect((await current(s)).status).toBe(200);
    });

    it("gives one identical answer for a wrong, malformed, unknown, expired, revoked or used code", async () => {
      const s = await register();
      const id = await idOf(s.reference);
      const answers: Reply[] = [
        await recoverWith("ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ"),
        await recoverWith("not a code"),
        await recoverWith(""),
        await recoverWith("0".repeat(24)),
        await recoverWith(s.code.slice(0, -1) + (s.code.endsWith("A") ? "B" : "A")),
      ];
      await sql("UPDATE registration_recovery SET revoked_at = ? WHERE submission_id = ?", [now(), id]);
      answers.push(await recoverWith(s.code));
      await sql("UPDATE registration_recovery SET revoked_at = NULL, used_at = ? WHERE submission_id = ?", [now(), id]);
      answers.push(await recoverWith(s.code));
      await sql("UPDATE registration_recovery SET used_at = NULL WHERE submission_id = ?", [id]);
      clock.t += 31 * DAY;
      answers.push(await recoverWith(s.code));
      for (const a of answers) {
        expect(a.status).toBe(401);
        expect(a.body.error?.code).toBe("recovery_failed");
        expect(a.body.error?.message).toBe(answers[0]!.body.error?.message);
        expect(a.cookie).toBeNull();
        expect(a.text.replace(/"requestId":"[^"]+"/, "")).toBe(answers[0]!.text.replace(/"requestId":"[^"]+"/, ""));
      }
    });

    it("stops working when the code expires, on both paths, and clears the cookie", async () => {
      const s = await register();
      clock.t += 29 * DAY;
      expect((await current(s)).status).toBe(200);
      expect((await recoverWith(s.code)).status).toBe(200);
      clock.t += 2 * DAY;
      const stale = await current(s);
      expect(stale.status).toBe(401);
      expect(stale.body.error?.code).toBe("no_registration");
      expect(stale.setCookie).toMatch(/rio_reg=;/);
      expect((await recoverWith(s.code)).status).toBe(401);
    });

    it("never accepts a name, a mobile number or a reference as a way in", async () => {
      const mob = "9222222222";
      const s = await register({ childName: "Secret Child", guardianMobile: mob, guardianName: "Secret Guardian" });
      for (const guess of [mob, "+919222222222", "Secret Child", s.reference, s.reference.repeat(3).slice(0, 24)]) expect((await recoverWith(guess)).status, guess).toBe(401);
      const noCookie = await call("/api/v1/registrations/current", { origin: null });
      expect(noCookie.status).toBe(401);
      const asQuery = await call(`/api/v1/registrations/current?code=${canonicalCode(s.code)}&mobile=${mob}&name=Secret%20Child&reference=${s.reference}`, { origin: null });
      expect(asQuery.status).toBe(401);
      const asHeader = await fetch(`${base}/api/v1/registrations/current`, { headers: { authorization: `Bearer ${canonicalCode(s.code)}`, "x-recovery-code": canonicalCode(s.code)!, "x-forwarded-for": freshIp() } });
      expect(asHeader.status).toBe(401);
    });

    it("answers 401 for no cookie, a random cookie, a cookie of the wrong shape and a cookie in a staff cookie's name", async () => {
      const s = await register();
      for (const cookie of [null, "rio_reg=ZZZZZZZZZZZZZZZZZZZZZZZZ", "rio_reg=garbage", "rio_reg=' OR 1=1 --", `rio_staff=${canonicalCode(s.code)}`, `other=${canonicalCode(s.code)}`]) {
        const r = await call("/api/v1/registrations/current", { cookie, origin: null });
        expect(r.status, String(cookie)).toBe(401);
        expect(r.body.error?.code).toBe("no_registration");
      }
    });

    it("limits recovery attempts per address, even for the right code, and recovers after the window", async () => {
      const s = await register();
      const ip = freshIp();
      for (let i = 0; i < REGISTRATION_LIMITS.recoverPerIp.max; i++) expect((await recoverWith("ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ", { ip })).status).toBe(401);
      const limited = await recoverWith(s.code, { ip });
      expect(limited.status).toBe(429);
      expect(limited.body.error?.code).toBe("rate_limited");
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await recoverWith(s.code, { ip: freshIp() })).status).toBe(200); // another address is unaffected
      clock.t += 16 * 60_000;
      expect((await recoverWith(s.code, { ip })).status).toBe(200);
    });

    it("shares the recovery limit between server instances", async () => {
      const second = await start();
      const ip = freshIp();
      for (let i = 0; i < REGISTRATION_LIMITS.recoverPerIp.max; i++) await recoverWith("ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ", { ip, baseUrl: i % 2 ? second : base });
      expect((await recoverWith("ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ", { ip, baseUrl: second })).status).toBe(429);
      expect((await recoverWith("ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ", { ip, baseUrl: base })).status).toBe(429);
    });

    it("needs an allowed Origin to recover", async () => {
      const s = await register();
      expect((await recoverWith(s.code, { origin: "http://evil.test" })).status).toBe(403);
      expect((await recoverWith(s.code, { origin: null })).status).toBe(403);
    });

    it("audits a recovery without the code, and leaves failures out of the log", async () => {
      const s = await register();
      const before = await scalar("SELECT COUNT(*) AS n FROM audit_log");
      await recoverWith("ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ");
      expect(await scalar("SELECT COUNT(*) AS n FROM audit_log")).toBe(before);
      await recoverWith(s.code);
      expect(await scalar("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'registration.recovered' AND entity_id = ?", [String(await idOf(s.reference))])).toBe(1);
    });
  });

  // ---- isolation -----------------------------------------------------------------------------------------------------------------------
  describe("access control between entries", () => {
    it("lets a cookie reach only its own entry, and a CSRF token work only with its own cookie", async () => {
      const a = await register({ childName: "Child A" });
      const b = await register({ childName: "Child B" });
      expect((await current(a)).body.registration!.child.name).toBe("Child A");
      expect((await current(b)).body.registration!.child.name).toBe("Child B");
      expect((await patch({ cookie: a.cookie, csrf: b.csrf }, { childName: "Hijacked" })).status).toBe(403);
      expect((await patch({ cookie: b.cookie, csrf: a.csrf }, { childName: "Hijacked" })).status).toBe(403);
      expect((await patch(a, { childName: "Child A Edited" })).status).toBe(200);
      expect((await row(b.reference)).child_name).toBe("Child B");
      expect((await row(a.reference)).child_name).toBe("Child A Edited");
    });

    it("exposes no way to list, search or address entries", async () => {
      const s = await register();
      const id = await idOf(s.reference);
      for (const path of ["/api/v1/registrations", `/api/v1/registrations/${id}`, `/api/v1/registrations/${s.reference}`, "/api/v1/registrations/search?mobile=9876543210", "/api/v1/registrations/current/answers", "/api/v1/entries", "/api/v1/submissions"]) {
        const r = await call(path, { cookie: s.cookie, origin: null });
        expect(r.status, path).toBe(404);
      }
      expect((await call(`/api/v1/registrations/${id}`, { method: "PATCH", cookie: s.cookie, csrf: s.csrf, body: { childName: "X" } })).status).toBe(404);
      expect((await call("/api/v1/registrations/current", { method: "DELETE", cookie: s.cookie, csrf: s.csrf, body: {} })).status).toBe(404);
    });

    it("keeps staff and registration credentials apart in both directions", async () => {
      const s = await register();
      const password = "Staff-Boundary-Pass-77";
      const email = `boundary${next()}@example.org`;
      await sql("INSERT INTO staff_users (email, password_hash, role, display_name, must_change_password, created_at) VALUES (?, ?, 'admin', 'Boundary Admin', 0, ?)", [email, await hashPassword(password, { memoryKib: 1024, passes: 1 }), now()]);
      const login = await fetch(`${base}/api/v1/staff/login`, { method: "POST", headers: { "content-type": "application/json", origin: ADMIN, "x-forwarded-for": freshIp() }, body: JSON.stringify({ email, password }) });
      expect(login.status).toBe(200);
      const staffCookie = login.headers.getSetCookie().find((c) => c.startsWith("rio_staff="))!.split(";")[0]!;
      const staffCsrf = ((await login.json()) as { csrfToken: string }).csrfToken;

      // a signed-in administrator is not a parent: no entry is reachable with the staff cookie or its CSRF token
      expect((await call("/api/v1/registrations/current", { cookie: staffCookie, origin: null })).status).toBe(401);
      expect((await patch({ cookie: staffCookie, csrf: staffCsrf }, { childName: "Admin Edit" })).status).toBe(401);
      expect((await patch({ cookie: s.cookie, csrf: staffCsrf }, { childName: "Admin Edit" })).status).toBe(403);
      // a parent is not staff
      expect((await fetch(`${base}/api/v1/staff/me`, { headers: { cookie: s.cookie } })).status).toBe(401);
      expect((await fetch(`${base}/api/v1/staff/logout`, { method: "POST", headers: { cookie: s.cookie, origin: ADMIN, "x-csrf-token": s.csrf, "content-type": "application/json" }, body: "{}" })).status).toBe(204); // nothing to end
      expect((await current(s)).status).toBe(200); // and it did not touch the registration
      // each side's Origin works only on its own routes
      expect((await create({}, { origin: ADMIN })).status).toBe(403);
      const staffFromSite = await fetch(`${base}/api/v1/staff/login`, { method: "POST", headers: { "content-type": "application/json", origin: SITE, "x-forwarded-for": freshIp() }, body: JSON.stringify({ email, password }) });
      expect(staffFromSite.status).toBe(403);
    });

    it("answers a preflight for PATCH from the public site only", async () => {
      const pre = (origin: string) => fetch(`${base}/api/v1/registrations/current`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "PATCH", "access-control-request-headers": "content-type,x-csrf-token" } });
      const ok = await pre(SITE);
      expect(ok.status).toBe(204);
      expect(ok.headers.get("access-control-allow-origin")).toBe(SITE);
      expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
      expect(ok.headers.get("access-control-allow-methods")).toContain("PATCH");
      expect((await pre("http://evil.test")).headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  // ---- editing -------------------------------------------------------------------------------------------------------------------------
  describe("PATCH /api/v1/registrations/current", () => {
    it("changes only the fields given, normalises them, and returns the entry", async () => {
      const s = await register({ guardianEmail: "old@example.org" });
      const r = await patch(s, { childName: ` ${DECOMPOSED}  ராமன் `, childAge: 7, guardianName: "புதிய பெயர்", guardianMobile: "+91 98765 00001", guardianEmail: "NEW@Example.org" });
      expect(r.status).toBe(200);
      expect(r.body.registration).toMatchObject({ child: { name: `${COMPOSED} ராமன்`, age: 7 }, guardian: { name: "புதிய பெயர்", mobile: "+919876500001", email: "new@example.org" }, status: "draft" });
      const e = await row(s.reference);
      expect(e.child_name_norm).toBe(`${COMPOSED} ராமன்`);
      expect(new Date(String(e.updated_at instanceof Date ? e.updated_at.toISOString() : e.updated_at)).getTime()).toBe(clock.t);
      const partial = await patch(s, { childAge: 8 });
      expect(partial.body.registration).toMatchObject({ child: { name: `${COMPOSED} ராமன்`, age: 8 }, guardian: { email: "new@example.org" } });
    });

    it("can remove the e-mail address and withdraw or change the media answer", async () => {
      const s = await register({ guardianEmail: "gone@example.org", mediaConsent: { granted: true, version: "m1" } });
      expect((await patch(s, { guardianEmail: null })).body.registration!.guardian.email).toBeNull();
      expect((await patch(s, { mediaConsent: { granted: false, version: "m1" } })).body.registration!.consent.media.granted).toBe(false);
      const cleared = await patch(s, { mediaConsent: null });
      expect(cleared.body.registration!.consent.media).toEqual({ granted: null, version: null, at: null });
      expect(cleared.body.registration!.consent.guardian.version).toBe("v1"); // the guardian's consent is untouched
    });

    it("re-records the guardian's consent under the current wording and audits it, without the content", async () => {
      const s = await register();
      clock.t += HOUR;
      await openRegistration({ guardian: "v2" });
      expect((await patch(s, { guardianConsent: { accepted: true, version: "v1" } })).body.error?.code).toBe("consent_version_changed");
      const r = await patch(s, { guardianConsent: { accepted: true, version: "v2" } });
      expect(r.body.registration!.consent.guardian).toEqual({ version: "v2", at: now().toISOString() });
      expect(await scalar("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'registration.consent_recorded' AND entity_id = ?", [String(await idOf(s.reference))])).toBe(1);
    });

    it("refuses an empty change, unknown fields, and fields that may not be changed (competition, status, consent time, references)", async () => {
      const s = await register();
      expect((await patch(s, {})).body.error?.fields).toEqual([{ field: "(body)", problem: "nothing_to_change" }]);
      for (const extra of [{ eventSlug: "kathai-sollum" }, { status: "finalized" }, { entryCode: "AAAAAAAAAA" }, { guardianConsentAt: "2020-01-01" }, { questionSetId: 2 }]) {
        const r = await patch(s, extra);
        expect(r.status, JSON.stringify(extra)).toBe(422);
      }
      expect((await row(s.reference)).status).toBe("draft");
    });

    it("applies the same checks as creation: age range, mobile, name, and nothing partial is saved", async () => {
      const s = await register({ eventSlug: "kathai-sollum", childAge: 6 });
      const r = await patch(s, { childName: "Valid Name", childAge: 12, guardianMobile: "12345" });
      expect(r.status).toBe(422);
      expect(r.body.error?.fields).toEqual(expect.arrayContaining([{ field: "guardianMobile", problem: "invalid_mobile" }]));
      expect((await patch(s, { childAge: 12 })).body.error?.fields).toEqual([{ field: "childAge", problem: "out_of_range" }]);
      expect((await row(s.reference)).child_name).toBe("Asha Kumar");
      expect(Number((await row(s.reference)).child_age)).toBe(6);
    });

    it("needs the CSRF token and an allowed Origin", async () => {
      const s = await register();
      const send = (o: Options) => call("/api/v1/registrations/current", { method: "PATCH", cookie: s.cookie, body: { childAge: 7 }, ...o });
      expect((await send({ csrf: null })).body.error?.code).toBe("csrf_invalid");
      expect((await send({ csrf: "wrong" })).status).toBe(403);
      expect((await send({ csrf: s.csrf, origin: "http://evil.test" })).status).toBe(403);
      expect((await send({ csrf: s.csrf, origin: null })).status).toBe(403);
      expect((await send({ csrf: s.csrf, cookie: null })).status).toBe(401);
      expect(Number((await row(s.reference)).child_age)).toBe(6);
      expect((await send({ csrf: s.csrf })).status).toBe(200);
    });

    it("refuses changes once the registration window has closed, but still lets the parent read the entry", async () => {
      const s = await register();
      await openRegistration({ open: -2 * HOUR, close: -HOUR });
      const r = await patch(s, { childAge: 7 });
      expect(r.status).toBe(403);
      expect(r.body.error?.code).toBe("registration_closed");
      expect((await current(s)).status).toBe(200);
      expect(Number((await row(s.reference)).child_age)).toBe(6);
    });

    it("stops editing an entry that has been submitted, and shows it read-only", async () => {
      const s = await register();
      await finalizeEntry(await idOf(s.reference));
      const r = await patch(s, { childName: "Too Late" });
      expect(r.status).toBe(409);
      expect(r.body.error?.code).toBe("not_editable");
      const view = (await current(s)).body.registration!;
      expect(view).toMatchObject({ status: "finalized", editable: false });
      expect((await row(s.reference)).child_name).toBe("Asha Kumar");
    });

    it("is not defeated by a race with submission: an update that loses to a submitted entry changes nothing", async () => {
      const s = await register();
      const id = await idOf(s.reference);
      await finalizeEntry(id);
      await expect(sql("UPDATE submissions SET child_name = 'Sneaky' WHERE id = ?", [id])).rejects.toMatchObject({ constraint: "rule" }); // the database refuses it too
    });

    it("limits how often one entry can be written", async () => {
      const s = await register();
      const results: number[] = [];
      for (let i = 0; i < REGISTRATION_LIMITS.writePerEntry.max + 3; i++) results.push((await patch(s, { childAge: 6 + (i % 2) })).status);
      expect(results.slice(0, REGISTRATION_LIMITS.writePerEntry.max).every((c) => c === 200)).toBe(true);
      expect(results.slice(-3)).toEqual([429, 429, 429]);
    }, 60_000);

    it("keeps simultaneous edits intact: different fields all land, and one answer ends with exactly one of the values", async () => {
      const s = await register();
      const results = await Promise.all([
        patch(s, { childAge: 9 }),
        patch(s, { guardianName: "Parallel Guardian" }),
        patch(s, { guardianEmail: "parallel@example.org" }),
        ...["x", "y", "z", "w"].map((v) => patch(s, { answers: { school: `School ${v}` } })),
      ]);
      expect(results.map((r) => r.status)).toEqual(Array(7).fill(200));
      const e = await row(s.reference);
      expect(Number(e.child_age)).toBe(9);
      expect(e.guardian_name).toBe("Parallel Guardian");
      expect(e.guardian_email).toBe("parallel@example.org");
      const answers = (await sql<{ value_text: string }>("SELECT value_text FROM entry_answers WHERE submission_id = ?", [Number(e.id)])).rows;
      expect(answers).toHaveLength(1);
      expect(["School x", "School y", "School z", "School w"]).toContain(answers[0]!.value_text);
    });
  });

  // ---- competition questions -----------------------------------------------------------------------------------------------------------
  describe("answers to the competition's questions", () => {
    it("saves an answer of the right shape for every question type, Tamil and four-byte text included, and reads them back", async () => {
      const s = await register();
      const r = await patch(s, { answers: { school: "அரசு பள்ளி 😀", about: "முதல் வரி\nஇரண்டாவது வரி", group: "b", level: "c", hobbies: ["c", "a"], siblings: 2.5 } });
      expect(r.status).toBe(200);
      expect(r.body.registration!.answers).toEqual({ school: "அரசு பள்ளி 😀", about: "முதல் வரி\nஇரண்டாவது வரி", group: "b", level: "c", hobbies: ["a", "c"], siblings: 2.5 });
      expect(r.body.registration!.missingRequired).toEqual([]);
      const stored = (await sql<{ k: string; question_type: string }>("SELECT q.question_key AS k, a.question_type FROM entry_answers a JOIN questions q ON q.id = a.question_id WHERE a.submission_id = ? ORDER BY q.position", [await idOf(s.reference)])).rows;
      expect(stored.map((x) => `${x.k}:${x.question_type}`)).toEqual(["school:short_text", "about:paragraph", "group:dropdown", "level:radio", "hobbies:checkboxes", "siblings:number"]);
      expect((await current(s)).body.registration!.answers).toEqual(r.body.registration!.answers);
    });

    it("updates and clears answers (null, empty text, empty list)", async () => {
      const s = await register();
      await patch(s, { answers: { school: "One", hobbies: ["a"], group: "a" } });
      const changed = await patch(s, { answers: { school: "Two", hobbies: ["b", "c"] } });
      expect(changed.body.registration!.answers).toEqual({ school: "Two", hobbies: ["b", "c"], group: "a" });
      const cleared = await patch(s, { answers: { school: null, hobbies: [], group: "" } });
      expect(cleared.body.registration!.answers).toEqual({});
      expect(cleared.body.registration!.missingRequired).toEqual(["school"]);
    });

    it.each([
      ["an answer to an unknown question", { nothing_here: "x" }, "unknown_question"],
      ["an answer to an instruction", { note: "ok" }, "no_answer_allowed"],
      ["text for a number", { siblings: "3" }, "wrong_type"],
      ["a number above the limit", { siblings: 11 }, "out_of_range"],
      ["an option that is not offered", { group: "z" }, "not_an_option"],
      ["a list for a dropdown", { group: ["a"] }, "wrong_type"],
      ["a duplicate checkbox", { hobbies: ["a", "a"] }, "duplicate"],
      ["a checkbox that is not offered", { hobbies: ["a", "q"] }, "not_an_option"],
      ["text over the question's length limit", { school: "அ".repeat(41) }, "too_long"],
      ["control characters", { school: "bad\u0007text" }, "invalid_text"],
      ["an invalid key", { "Bad Key": "x" }, "invalid_key"],
    ])("refuses %s", async (_label, answers, problem) => {
      const s = await register();
      const r = await patch(s, { answers });
      expect(r.status).toBe(422);
      expect(r.body.error?.fields?.[0]?.problem).toBe(problem);
      expect(Object.keys((await current(s)).body.registration!.answers)).toEqual([]);
    });

    it("is all or nothing: one bad answer, or one bad field, saves none of the others", async () => {
      const s = await register();
      const r = await patch(s, { childName: "Would Change", answers: { school: "Valid", siblings: 99 } });
      expect(r.status).toBe(422);
      expect(r.body.error?.fields).toEqual([{ field: "answers.siblings", problem: "out_of_range" }]);
      expect((await row(s.reference)).child_name).toBe("Asha Kumar");
      expect(await scalar("SELECT COUNT(*) AS n FROM entry_answers WHERE submission_id = ?", [await idOf(s.reference)])).toBe(0);
    });

    it("keeps an entry on the question set it was created with when a newer set is published", async () => {
      const eventId = await addEvent(`versioned-${next()}`, 3, 12);
      const v1 = await publishSet(eventId, 1, true);
      const slug = (await sql<{ slug: string }>("SELECT slug FROM events WHERE id = ?", [eventId])).rows[0]!.slug;
      const early = await register({ eventSlug: slug });
      await patch(early, { answers: { school: "Early answer" } });

      await sql("UPDATE question_sets SET status = 'retired', retired_at = ? WHERE id = ?", [now(), v1]);
      await sql("INSERT INTO question_sets (event_id, version) VALUES (?, 2)", [eventId]);
      const v2 = Number((await sql<{ id: number }>("SELECT id FROM question_sets WHERE event_id = ? AND version = 2", [eventId])).rows[0]!.id);
      await sql("INSERT INTO questions (question_set_id, position, question_key, type, prompt_ta, prompt_en, required) VALUES (?, 1, 'favourite', 'short_text', 'பிடித்தது', 'Favourite thing', 1)", [v2]);
      await sql("UPDATE question_sets SET status = 'published', published_at = ? WHERE id = ?", [now(), v2]);

      const stillV1 = (await current(early)).body.registration!;
      expect(stillV1.questionSet.version).toBe(1);
      expect(stillV1.questionSet.questions.map((q) => q.key)).toContain("school");
      expect((await patch(early, { answers: { school: "Edited under v1" } })).status).toBe(200);
      expect((await patch(early, { answers: { favourite: "x" } })).body.error?.fields).toEqual([{ field: "answers.favourite", problem: "unknown_question" }]);

      const late = await register({ eventSlug: slug });
      expect(late.reply.body.registration!.questionSet).toMatchObject({ version: 2 });
      expect(Number((await row(late.reference)).question_set_id)).toBe(v2);
      expect((await patch(late, { answers: { favourite: "Painting" } })).status).toBe(200);
      expect((await patch(late, { answers: { school: "x" } })).body.error?.fields?.[0]?.problem).toBe("unknown_question");
    });
  });

  // ---- privacy -------------------------------------------------------------------------------------------------------------------------
  describe("what is never stored, logged or returned", () => {
    it("keeps names, mobile numbers, e-mail addresses, codes and addresses out of the logs, audit log and rate-limit tables", async () => {
      const ip = "203.0.113.77";
      const mob = "9333333333";
      const s = await register({ childName: "கீர்த்தனா ரகசியம்", guardianName: "Guardian Rahasya", guardianMobile: mob, guardianEmail: "private.person@example.org", mediaConsent: { granted: true, version: "m1" } }, { ip });
      await patch(s, { childName: "கீர்த்தனா மாற்றம்", answers: { school: "Hidden School Name" } }, { ip });
      await recoverWith(s.code, { ip });
      await recoverWith("ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ", { ip });
      await create({ childName: "Bad<>Name", guardianMobile: "bad-number-9333333333" }, { ip });
      const secrets = ["கீர்த்தனா", "Rahasya", mob, "private.person", "Hidden School", canonicalCode(s.code)!, s.code, ip, "bad-number"];
      const places = { logs: log.lines.join("\n"), tables: await dump() };
      for (const [where, text] of Object.entries(places)) for (const secret of secrets) expect(text, `${where} contains ${secret}`).not.toContain(secret);
    });

    it("returns the entry only to its code holder and never another child's details", async () => {
      const a = await register({ childName: "Visible To A", guardianMobile: "9444444441" });
      const b = await register({ childName: "Visible To B", guardianMobile: "9444444442" });
      const textA = (await current(a)).text;
      expect(textA).toContain("Visible To A");
      expect(textA).not.toContain("Visible To B");
      expect(textA).not.toContain("9444444442");
      expect((await call("/api/v1/events")).text + (await call("/api/v1/settings/public")).text).not.toMatch(/Visible To|944444444/);
      expect(b.reference).not.toBe(a.reference);
    });

    it("returns no database ids, digests or internal columns in any registration response", async () => {
      const s = await register();
      const text = s.reply.text + (await current(s)).text;
      expect(text).not.toMatch(/token_sha256|"id"|submission_id|question_set_id|child_name_norm|finalized_flag|password/i);
    });
  });

  // ---- create limits -------------------------------------------------------------------------------------------------------------------
  describe("registration rate limits (shared, in the database)", () => {
    it("limits creations per address, with the same answer whether or not the child is known, and recovers after the window", async () => {
      const ip = freshIp();
      for (let i = 0; i < REGISTRATION_LIMITS.createPerIp.max; i++) expect((await create({}, { ip })).status).toBe(201);
      const limited = await create({}, { ip });
      expect(limited.status).toBe(429);
      expect(limited.body.error?.code).toBe("rate_limited");
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await create({}, { ip: freshIp() })).status).toBe(201);
      clock.t += 61 * 60_000;
      expect((await create({}, { ip })).status).toBe(201);
    });

    it("limits creations per mobile number across addresses", async () => {
      const mob = mobile();
      for (let i = 0; i < REGISTRATION_LIMITS.createPerMobile.max; i++) expect((await create({ guardianMobile: mob }, { ip: freshIp() })).status).toBe(201);
      const limited = await create({ guardianMobile: mob }, { ip: freshIp() });
      expect(limited.status).toBe(429);
      expect((await create({ guardianMobile: mobile() }, { ip: freshIp() })).status).toBe(201);
    });

    it("counts in the shared database, so a second server instance sees the first one's creations", async () => {
      const second = await start();
      const ip = freshIp();
      for (let i = 0; i < REGISTRATION_LIMITS.createPerIp.max; i++) expect((await create({}, { ip, baseUrl: i % 2 ? second : base })).status).toBe(201);
      expect((await create({}, { ip, baseUrl: second })).status).toBe(429);
      expect((await create({}, { ip, baseUrl: base })).status).toBe(429);
    });

    it("admits exactly the first 'max' of a simultaneous burst, and keeps only digests of what it counted", async () => {
      const ip = freshIp();
      const results = await Promise.all(Array.from({ length: REGISTRATION_LIMITS.createPerIp.max + 10 }, () => create({}, { ip })));
      const accepted = results.filter((r) => r.status === 201).length;
      expect(accepted).toBe(REGISTRATION_LIMITS.createPerIp.max);
      expect(results.every((r) => r.status === 201 || r.status === 429)).toBe(true);
      const keys = (await sql<{ key_sha256: string }>("SELECT key_sha256 FROM rate_limits")).rows;
      expect(keys.every((k) => /^[0-9a-f]{64}$/.test(k.key_sha256))).toBe(true);
      expect(keys.map((k) => k.key_sha256)).toContain(createHash("sha256").update(ip).digest("hex"));
    });
  });
});
