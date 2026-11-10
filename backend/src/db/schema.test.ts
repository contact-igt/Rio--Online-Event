import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseAdapter, Dialect } from "./adapter.ts";
import { DatabaseError, type ConstraintKind } from "./errors.ts";
import { migrate, loadMigrations } from "./migrate.ts";
import { dialects, openTestDatabase } from "./test-db.ts";
import { APP_TABLES, dropAppSchema, installAppSchema, migrationsDir } from "./test-schema.ts";
import { asDate } from "./values.ts";

// The application schema (migrations 0001 to 0010) against every configured dialect. Declarative rules (CHECK, foreign keys, unique keys)
// are asserted as such; rules that need a trigger come back as constraint kind "rule". Where MySQL and SQLite differ on purpose, the
// difference is asserted per dialect in the last block, so it cannot change unnoticed.
//
// All tests share the fixed table names of the real schema, so everything lives in this one file; a test database is never shared with
// another file that creates the same tables. Each test builds its own competition, so tests do not depend on each other, except the
// "results publication" block at the end, which publishes results and therefore freezes the winners table: it must stay last.

const TRACKING = "zz_schema_migrations";

const caught = async (work: Promise<unknown>): Promise<unknown> => work.then(() => undefined, (error: unknown) => error);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const json = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe.each(dialects)("%s application schema", (dialect: Dialect) => {
  let db: DatabaseAdapter;
  const q = <Row = Record<string, unknown>>(sql: string, params: readonly (string | number | Date | null)[] = []) => db.query<Row>(sql, params);

  beforeAll(async () => {
    db = openTestDatabase(dialect);
    await installAppSchema(db, TRACKING);
  }, 120_000);
  afterAll(async () => {
    await dropAppSchema(db, TRACKING);
    await db.close();
  });

  // ---- helpers -----------------------------------------------------------------------------------------------------------------------
  let counter = 0;
  const next = () => ++counter;

  async function insert(table: string, row: Record<string, string | number | Date | null>): Promise<void> {
    const columns = Object.keys(row);
    await q(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, Object.values(row));
  }
  async function idOf(table: string, column: string, value: string | number): Promise<number> {
    const { rows } = await q<{ id: number }>(`SELECT id FROM ${table} WHERE ${column} = ?`, [value]);
    if (rows.length !== 1) throw new Error(`expected one ${table} row`);
    return Number(rows[0]!.id);
  }
  const count = async (sql: string, params: readonly (string | number | Date | null)[] = []) => Number((await q<{ n: number }>(sql, params)).rows[0]!.n);
  async function violation(work: Promise<unknown>, constraint: ConstraintKind) {
    const error = await caught(work);
    expect(error, "expected the database to refuse this").toBeInstanceOf(DatabaseError);
    expect(error).toMatchObject({ kind: "constraint", constraint });
  }
  const dbNow = async (): Promise<Date> =>
    asDate((await q<{ t: unknown }>(dialect === "mysql" ? "SELECT UTC_TIMESTAMP(3) AS t" : "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS t")).rows[0]!.t);

  async function staff(role: "admin" | "judge" = "admin", active: 0 | 1 = 1): Promise<number> {
    const email = `staff${next()}@example.org`;
    await insert("staff_users", { email, password_hash: "h".repeat(60), role, display_name: "நிர்வாகி Staff", active });
    return idOf("staff_users", "email", email);
  }
  async function event(minAge = 3, maxAge = 12): Promise<number> {
    const slug = `ev-${next()}`;
    await insert("events", { slug, name_ta: "போட்டி", name_en: "Contest", min_age: minAge, max_age: maxAge });
    return idOf("events", "slug", slug);
  }
  async function questionSet(eventId: number, version: number, status: "draft" | "published" = "published"): Promise<number> {
    await insert("question_sets", { event_id: eventId, version });
    const id = Number((await q<{ id: number }>("SELECT id FROM question_sets WHERE event_id = ? AND version = ?", [eventId, version])).rows[0]!.id);
    if (status === "published") await q("UPDATE question_sets SET status = 'published', published_at = ? WHERE id = ?", [new Date(), id]);
    return id;
  }
  const OPTIONS = JSON.stringify([{ code: "a", ta: "அ", en: "A" }, { code: "b", ta: "ஆ", en: "B" }]);
  async function question(setId: number, position: number, type: string, extra: Record<string, string | number | null> = {}): Promise<number> {
    const key = `q${next()}`;
    const choice = ["dropdown", "radio", "checkboxes"].includes(type);
    await insert("questions", { question_set_id: setId, position, question_key: key, type, prompt_ta: "கேள்வி", prompt_en: "Question", options_json: choice ? OPTIONS : null, ...extra });
    return Number((await q<{ id: number }>("SELECT id FROM questions WHERE question_set_id = ? AND question_key = ?", [setId, key])).rows[0]!.id);
  }
  type World = { eventId: number; setId: number };
  async function world(): Promise<World> {
    const eventId = await event();
    return { eventId, setId: await questionSet(eventId, 1) };
  }
  /** A competition whose published set has one question of every type. */
  async function richWorld(): Promise<World & { ids: Record<string, number> }> {
    const eventId = await event();
    const setId = await questionSet(eventId, 1, "draft");
    const ids: Record<string, number> = {};
    let position = 1;
    for (const type of ["short_text", "paragraph", "dropdown", "radio", "checkboxes", "number", "instruction"]) ids[type] = await question(setId, position++, type);
    await q("UPDATE question_sets SET status = 'published', published_at = ? WHERE id = ?", [new Date(), setId]);
    return { eventId, setId, ids };
  }
  type Draft = { name?: string; norm?: string; mobile?: string; age?: number; email?: string; code?: string };
  async function draft(w: World, o: Draft = {}): Promise<number> {
    const code = o.code ?? `E${String(next()).padStart(7, "0")}`;
    await insert("submissions", {
      entry_code: code, event_id: w.eventId, question_set_id: w.setId, child_name: o.name ?? "Asha", child_name_norm: o.norm ?? (o.name ?? "Asha").toLowerCase(),
      child_age: o.age ?? 6, guardian_name: "Guardian", guardian_mobile: o.mobile ?? "+919876543210", guardian_email: o.email ?? "guardian@example.org",
      guardian_consent_version: "test-v1", guardian_consent_at: new Date(),
    });
    return idOf("submissions", "entry_code", code);
  }
  async function video(submissionId: number, status = "verified"): Promise<void> {
    await insert("video_uploads", {
      submission_id: submissionId, object_key: randomUUID(), content_type: "video/mp4", declared_bytes: 200_000, status,
      expires_at: new Date(Date.now() + HOUR), verified_at: status === "verified" ? new Date() : null, verified_bytes: status === "verified" ? 200_000 : null,
    });
  }
  const finalize = (id: number) => q("UPDATE submissions SET status = 'finalized', submitted_at = ?, finalized_at = ? WHERE id = ?", [new Date(), new Date(), id]);
  async function finalized(w: World, o: Draft = {}): Promise<number> {
    const id = await draft(w, o);
    await video(id);
    await finalize(id);
    return id;
  }
  const statusOf = async (id: number) => (await q<{ status: string }>("SELECT status FROM submissions WHERE id = ?", [id])).rows[0]!.status;

  // ---- migrations ---------------------------------------------------------------------------------------------------------------------
  describe("migrations", () => {
    it("creates every application table and the results view, and tracks all eleven migrations", async () => {
      const sql =
        dialect === "mysql"
          ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()"
          : "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'";
      const names = new Set((await q<{ name: string }>(sql)).rows.map((r) => String(r.name).toLowerCase()));
      for (const table of [...APP_TABLES, "published_winners", TRACKING]) expect(names.has(table), table).toBe(true);
      expect(Number((await q<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TRACKING}`)).rows[0]!.n)).toBe(11);
    });

    it("is idempotent: a second run applies nothing", async () => {
      await expect(migrate(db, await loadMigrations(migrationsDir(dialect)), TRACKING)).resolves.toEqual({ applied: [] });
    });
  });

  // ---- events and settings -----------------------------------------------------------------------------------------------------------
  describe("events", () => {
    it.each([
      ["a slug with a capital letter", { slug: "Bad-Slug" }],
      ["a slug with a space", { slug: "bad slug" }],
      ["a slug ending with a hyphen", { slug: "bad-" }],
      ["a slug with a double hyphen", { slug: "bad--slug" }],
      ["an empty English name", { name_en: "   " }],
      ["an age range that is reversed", { min_age: 9, max_age: 5 }],
      ["a maximum age above 18", { max_age: 19 }],
      ["a minimum age of 0", { min_age: 0 }],
    ])("refuses %s", async (_label, change) => {
      await violation(insert("events", { slug: `x-${next()}`, name_ta: "போட்டி", name_en: "Contest", min_age: 3, max_age: 12, ...change }), "check");
    });

    it("refuses a repeated slug", async () => {
      const slug = `dup-${next()}`;
      await insert("events", { slug, name_ta: "அ", name_en: "A", min_age: 3, max_age: 12 });
      await violation(insert("events", { slug, name_ta: "ஆ", name_en: "B", min_age: 3, max_age: 12 }), "unique");
    });
  });

  describe("event settings", () => {
    it("starts as one row with nothing set, which means registration is closed", async () => {
      const { rows } = await q("SELECT * FROM event_settings");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 1, submissions_open_at: null, submissions_close_at: null, results_publish_at: null, guardian_consent_version: null, media_consent_version: null });
    });

    it("allows only the single row", async () => {
      await violation(q("INSERT INTO event_settings (id) VALUES (2)"), "check");
      await violation(q("INSERT INTO event_settings (id) VALUES (1)"), "unique");
    });

    it("refuses a window that ends before it starts, and opening without a close time or a consent version", async () => {
      const t = Date.now();
      await violation(q("UPDATE event_settings SET submissions_open_at = ?, submissions_close_at = ?, guardian_consent_version = 'v1' WHERE id = 1", [new Date(t + DAY), new Date(t)]), "check");
      await violation(q("UPDATE event_settings SET submissions_open_at = ?, submissions_close_at = NULL, guardian_consent_version = 'v1' WHERE id = 1", [new Date(t)]), "check");
      await violation(q("UPDATE event_settings SET submissions_open_at = ?, submissions_close_at = ?, guardian_consent_version = NULL WHERE id = 1", [new Date(t), new Date(t + DAY)]), "check");
    });

    it("refuses a results time without a close time, before the close time, or a consent version with odd characters", async () => {
      const t = Date.now();
      await violation(q("UPDATE event_settings SET results_publish_at = ? WHERE id = 1", [new Date(t + 3 * DAY)]), "check");
      await violation(q("UPDATE event_settings SET submissions_open_at = ?, submissions_close_at = ?, guardian_consent_version = 'v1', results_publish_at = ? WHERE id = 1", [new Date(t), new Date(t + 2 * DAY), new Date(t + DAY)]), "check");
      await violation(q("UPDATE event_settings SET guardian_consent_version = 'has space' WHERE id = 1"), "check");
    });

    it("accepts a complete configuration, refuses a results time in the past, and can be cleared again before publication", async () => {
      const now = await dbNow();
      const t = now.getTime();
      await q("UPDATE event_settings SET submissions_open_at = ?, submissions_close_at = ?, guardian_consent_version = 'v1', media_consent_version = 'm1', results_publish_at = ? WHERE id = 1", [new Date(t - DAY), new Date(t + DAY), new Date(t + 3 * DAY)]);
      await violation(q("UPDATE event_settings SET results_publish_at = ? WHERE id = 1", [new Date(t - HOUR)]), "rule"); // back-dating would publish at once
      await q("UPDATE event_settings SET submissions_open_at = NULL, submissions_close_at = NULL, results_publish_at = NULL, guardian_consent_version = NULL, media_consent_version = NULL WHERE id = 1");
      expect((await q("SELECT results_publish_at FROM event_settings")).rows[0]).toEqual({ results_publish_at: null });
    });
  });

  // ---- staff, sessions, audit ----------------------------------------------------------------------------------------------------------
  describe("staff accounts and sessions", () => {
    const base = () => ({ password_hash: "h".repeat(60), role: "admin", display_name: "Staff" });

    it.each([
      ["an upper-case e-mail", { email: "Upper@Example.org" }],
      ["an e-mail without a domain", { email: "nobody" }],
      ["an unknown role", { email: "r@example.org", role: "owner" }],
      ["a password hash that is too short", { email: "p@example.org", password_hash: "short" }],
      ["an empty name", { email: "n@example.org", display_name: "  " }],
    ])("refuses %s", async (_label, change) => {
      await violation(insert("staff_users", { ...base(), ...change }), "check");
    });

    it("refuses a repeated e-mail", async () => {
      const email = `twice${next()}@example.org`;
      await insert("staff_users", { ...base(), email });
      await violation(insert("staff_users", { ...base(), email }), "unique");
    });

    it("stores a session only as a lower-case hex SHA-256 digest", async () => {
      const id = await staff();
      const expires = new Date(Date.now() + HOUR);
      const token = "raw-cookie-token-value";
      await violation(insert("staff_sessions", { staff_id: id, token_sha256: token, expires_at: expires }), "check"); // a plain token is refused
      await violation(insert("staff_sessions", { staff_id: id, token_sha256: sha256(token).toUpperCase(), expires_at: expires }), "check");
      await insert("staff_sessions", { staff_id: id, token_sha256: sha256(token), expires_at: expires });
      await violation(insert("staff_sessions", { staff_id: id, token_sha256: sha256(token), expires_at: expires }), "unique");
    });

    it("refuses a session that expires before it starts, a session for nobody, and removing a user who has sessions", async () => {
      const id = await staff();
      await violation(insert("staff_sessions", { staff_id: id, token_sha256: sha256(`a${next()}`), expires_at: new Date(Date.now() - DAY) }), "check");
      await violation(insert("staff_sessions", { staff_id: 999_999_999, token_sha256: sha256(`b${next()}`), expires_at: new Date(Date.now() + HOUR) }), "foreign_key");
      await insert("staff_sessions", { staff_id: id, token_sha256: sha256(`c${next()}`), expires_at: new Date(Date.now() + HOUR) });
      await violation(q("DELETE FROM staff_users WHERE id = ?", [id]), "foreign_key");
    });
  });

  describe("audit log", () => {
    const entry = (extra: Record<string, string | number | null> = {}) => ({ actor_type: "system", action: "entry.finalized", entity_type: "submission", entity_id: "12", ...extra });

    it("records actions and refuses malformed ones", async () => {
      await insert("audit_log", entry({ details: JSON.stringify({ from: "draft", to: "finalized" }) }));
      const adminId = await staff();
      await insert("audit_log", entry({ actor_type: "staff", actor_staff_id: adminId }));
      await violation(insert("audit_log", entry({ actor_type: "staff" })), "check"); // a staff action names the staff member
      await violation(insert("audit_log", entry({ actor_staff_id: adminId })), "check"); // a system action does not
      await violation(insert("audit_log", entry({ actor_type: "robot" })), "check");
      await violation(insert("audit_log", entry({ action: "Finalized Entry" })), "check");
      await violation(insert("audit_log", entry({ details: JSON.stringify(["not", "an", "object"]) })), "check");
      await violation(insert("audit_log", entry({ actor_type: "staff", actor_staff_id: 999_999_999 })), "foreign_key");
    });

    it("is append-only: rows cannot be changed or removed", async () => {
      await insert("audit_log", entry({ action: "entry.kept" }));
      await violation(q("UPDATE audit_log SET action = 'entry.edited' WHERE action = 'entry.kept'"), "rule");
      await violation(q("DELETE FROM audit_log WHERE action = 'entry.kept'"), "rule");
      expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'entry.kept'")).toBe(1);
    });
  });

  // ---- questions ---------------------------------------------------------------------------------------------------------------------
  describe("question sets and questions", () => {
    it("stores all seven types with Tamil and English text", async () => {
      const w = await richWorld();
      const { rows } = await q<{ type: string; prompt_ta: string; options_json: unknown }>("SELECT type, prompt_ta, options_json FROM questions WHERE question_set_id = ? ORDER BY position", [w.setId]);
      expect(rows.map((r) => r.type)).toEqual(["short_text", "paragraph", "dropdown", "radio", "checkboxes", "number", "instruction"]);
      expect(rows.every((r) => r.prompt_ta === "கேள்வி")).toBe(true);
      expect(json(rows[2]!.options_json)).toEqual([{ code: "a", ta: "அ", en: "A" }, { code: "b", ta: "ஆ", en: "B" }]);
    });

    it.each([
      ["a choice question without options", "dropdown", { options_json: null }],
      ["a text question that has options", "short_text", { options_json: OPTIONS }],
      ["a choice question with an empty option list", "radio", { options_json: "[]" }],
      ["options that are not a list", "checkboxes", { options_json: '{"code":"a"}' }],
      ["a required instruction", "instruction", { required: 1 }],
      ["a length limit on a number", "number", { max_length: 10 }],
      ["number bounds on a text question", "short_text", { min_number: 1, max_number: 5 }],
      ["number bounds that are reversed", "number", { min_number: 9, max_number: 1 }],
      ["an unknown type", "essay", {}],
      ["a blank Tamil prompt", "short_text", { prompt_ta: "  " }],
    ])("refuses %s", async (_label, type, extra) => {
      const setId = await questionSet(await event(), 1, "draft");
      await violation(question(setId, 1, type, extra as Record<string, string | number | null>), "check");
    });

    it("refuses a repeated position or key inside a set, but allows the same key in another set", async () => {
      const eventId = await event();
      const v1 = await questionSet(eventId, 1, "draft");
      const v2 = await questionSet(eventId, 2, "draft");
      await insert("questions", { question_set_id: v1, position: 1, question_key: "child_school", type: "short_text", prompt_ta: "பள்ளி", prompt_en: "School" });
      await violation(insert("questions", { question_set_id: v1, position: 1, question_key: "other", type: "short_text", prompt_ta: "அ", prompt_en: "A" }), "unique");
      await violation(insert("questions", { question_set_id: v1, position: 2, question_key: "child_school", type: "short_text", prompt_ta: "அ", prompt_en: "A" }), "unique");
      await insert("questions", { question_set_id: v2, position: 1, question_key: "child_school", type: "short_text", prompt_ta: "பள்ளி", prompt_en: "School" });
    });

    it("allows one published set per competition and numbers versions uniquely", async () => {
      const eventId = await event();
      await questionSet(eventId, 1);
      const second = await questionSet(eventId, 2, "draft");
      await violation(q("UPDATE question_sets SET status = 'published', published_at = ? WHERE id = ?", [new Date(), second]), "unique");
      await violation(insert("question_sets", { event_id: eventId, version: 2 }), "unique");
      await violation(insert("question_sets", { event_id: eventId, version: 0 }), "check");
      await violation(insert("question_sets", { event_id: 30_000, version: 1 }), "foreign_key"); // events.id is a SMALLINT: stay inside its range
    });

    it("keeps a published set and its questions immutable, and lets it be retired once", async () => {
      const w = await richWorld();
      const target = w.ids.short_text!;
      await violation(q("UPDATE questions SET prompt_en = 'Changed' WHERE id = ?", [target]), "rule");
      await violation(q("DELETE FROM questions WHERE id = ?", [target]), "rule");
      await violation(insert("questions", { question_set_id: w.setId, position: 99, question_key: "late", type: "short_text", prompt_ta: "அ", prompt_en: "A" }), "rule");
      await violation(q("UPDATE question_sets SET version = 9 WHERE id = ?", [w.setId]), "rule");
      await violation(q("UPDATE question_sets SET status = 'draft', published_at = NULL WHERE id = ?", [w.setId]), "rule");
      await violation(q("DELETE FROM question_sets WHERE id = ?", [w.setId]), "rule");
      await q("UPDATE question_sets SET status = 'retired', retired_at = ? WHERE id = ?", [new Date(), w.setId]);
      await violation(q("UPDATE question_sets SET status = 'published', retired_at = NULL WHERE id = ?", [w.setId]), "rule");
    });

    it("lets a draft set be edited freely", async () => {
      const setId = await questionSet(await event(), 1, "draft");
      const id = await question(setId, 1, "short_text");
      await q("UPDATE questions SET prompt_en = 'Edited' WHERE id = ?", [id]);
      await q("DELETE FROM questions WHERE id = ?", [id]);
      await q("DELETE FROM question_sets WHERE id = ?", [setId]);
    });
  });

  // ---- submissions -------------------------------------------------------------------------------------------------------------------
  describe("submissions", () => {
    it("stores Tamil, mixed-script and four-byte text exactly as given, and counts characters not bytes", async () => {
      const w = await world();
      const tamil = "கீர்த்தனா ஸ்ரீ";
      const id = await draft(w, { name: tamil, norm: tamil });
      const row = (await q<{ child_name: string; child_name_norm: string }>("SELECT child_name, child_name_norm FROM submissions WHERE id = ?", [id])).rows[0]!;
      expect(row).toEqual({ child_name: tamil, child_name_norm: tamil });
      await draft(w, { name: "Mia 𝒜😀", norm: "mia 𝒜😀", mobile: "+919876500001" });
      await draft(w, { name: "த".repeat(80), norm: "த".repeat(80), mobile: "+919876500002" }); // 80 characters, 240 bytes
      await violation(draft(w, { name: "த".repeat(81), norm: "த".repeat(81), mobile: "+919876500003" }), dialect === "mysql" ? "other" : "check");
      await violation(draft(w, { mobile: "+9198765432100" }), dialect === "mysql" ? "other" : "check"); // MySQL refuses over-long CHAR/VARCHAR values before CHECK
    });

    it("keeps different Unicode spellings of a name apart: normalising to NFC is the application's job (M4)", async () => {
      const w = await world();
      const composed = "கொ"; // KA + vowel sign O
      const decomposed = "கொ"; // KA + vowel sign E + AA length mark: the same letter, different code points
      expect(composed).not.toBe(decomposed);
      expect(composed.normalize("NFC")).toBe(decomposed.normalize("NFC"));
      await finalized(w, { name: composed, norm: composed });
      await finalized(w, { name: decomposed, norm: decomposed }); // accepted: the database compares code points exactly
      expect(await count("SELECT COUNT(*) AS n FROM submissions WHERE event_id = ? AND status = 'finalized'", [w.eventId])).toBe(2);
    });

    it("compares normalised names exactly: case and trailing spaces count (the application lower-cases and trims)", async () => {
      const w = await world();
      await finalized(w, { name: "Asha", norm: "asha" });
      await finalized(w, { name: "Asha", norm: "Asha" });
      await finalized(w, { name: "Asha", norm: "asha " });
      expect(await count("SELECT COUNT(*) AS n FROM submissions WHERE event_id = ? AND status = 'finalized'", [w.eventId])).toBe(3);
    });

    it.each([
      ["a mobile number without +91", { mobile: "9876543210" }],
      ["a mobile number starting with 5", { mobile: "+915876543210" }],
      ["a mobile number with a letter", { mobile: "+9198765x3210" }],
      ["an upper-case guardian e-mail", { email: "Guardian@Example.org" }],
      ["a guardian e-mail with two @", { email: "a@b@example.org" }],
      ["an empty normalised name", { norm: "" }],
    ])("refuses %s", async (_label, change) => {
      await violation(draft(await world(), change as Draft), "check");
    });

    it("refuses a repeated entry code and an entry that does not start as a draft", async () => {
      const w = await world();
      await draft(w, { code: "DUPCODE01" });
      await violation(draft(w, { code: "DUPCODE01" }), "unique");
      await violation(insert("submissions", { entry_code: `F${next()}ABCDE`, event_id: w.eventId, question_set_id: w.setId, status: "finalized", child_name: "A", child_name_norm: "a", child_age: 6, guardian_name: "G", guardian_mobile: "+919876543210", guardian_email: "g@example.org", guardian_consent_version: "v1", guardian_consent_at: new Date(), submitted_at: new Date(), finalized_at: new Date() }), "rule");
    });

    it("enforces age eligibility for the competition on insert and on update", async () => {
      const eventId = await event(5, 8);
      const w = { eventId, setId: await questionSet(eventId, 1) };
      await draft(w, { age: 5, mobile: "+919876500011" });
      await draft(w, { age: 8, mobile: "+919876500012" });
      await violation(draft(w, { age: 4, mobile: "+919876500013" }), "rule");
      await violation(draft(w, { age: 9, mobile: "+919876500014" }), "rule");
      await violation(draft(w, { age: 0, mobile: "+919876500016" }), "rule"); // the trigger answers before the CHECK would
      await violation(draft(w, { age: 19, mobile: "+919876500017" }), "rule");
      const id = await draft(w, { age: 6, mobile: "+919876500015" });
      await violation(q("UPDATE submissions SET child_age = 12 WHERE id = ?", [id]), "rule");
      await q("UPDATE submissions SET child_age = 7 WHERE id = ?", [id]);
    });

    it("ties an entry to its competition: the question set must belong to the same event and be the published one", async () => {
      const a = await world();
      const b = await world();
      await violation(draft({ eventId: a.eventId, setId: b.setId }), "foreign_key");
      const eventId = await event();
      const retired = await questionSet(eventId, 1);
      await q("UPDATE question_sets SET status = 'retired', retired_at = ? WHERE id = ?", [new Date(), retired]);
      await violation(draft({ eventId, setId: retired }), "rule");
      const unpublished = await questionSet(eventId, 2, "draft");
      await violation(draft({ eventId, setId: unpublished }), "rule");
    });

    it("records the guardian's consent and the optional media consent separately", async () => {
      const w = await world();
      const id = await draft(w);
      const row = async () => (await q<{ media_consent: number | null; media_consent_version: string | null }>("SELECT media_consent, media_consent_version FROM submissions WHERE id = ?", [id])).rows[0]!;
      expect(await row()).toEqual({ media_consent: null, media_consent_version: null }); // never asked
      await q("UPDATE submissions SET media_consent = 0, media_consent_version = 'm1', media_consent_at = ? WHERE id = ?", [new Date(), id]);
      expect(Number((await row()).media_consent)).toBe(0); // asked and declined: not the same as never asked
      await q("UPDATE submissions SET media_consent = 1 WHERE id = ?", [id]);
      await violation(q("UPDATE submissions SET media_consent = 2 WHERE id = ?", [id]), "check");
      await violation(q("UPDATE submissions SET media_consent_at = NULL WHERE id = ?", [id]), "check");
      await violation(q("UPDATE submissions SET media_consent_version = NULL WHERE id = ?", [id]), "check");
      await violation(q("UPDATE submissions SET guardian_consent_at = NULL WHERE id = ?", [id]), "check"); // version and time go together
      const bare = await draft(w, { mobile: "+919876500021" });
      await q("UPDATE submissions SET guardian_consent_version = NULL, guardian_consent_at = NULL WHERE id = ?", [bare]);
      await video(bare);
      await violation(finalize(bare), "check"); // no guardian consent, no submission
    });

    it("needs a verified video before an entry is submitted", async () => {
      const w = await world();
      const id = await draft(w);
      await violation(finalize(id), "rule");
      await video(id, "issued"); // an unverified upload does not count
      await violation(finalize(id), "rule");
      await violation(q("UPDATE submissions SET status = 'held', submitted_at = ? WHERE id = ?", [new Date(), id]), "rule");
      await video(id);
      await finalize(id);
      expect(await statusOf(id)).toBe("finalized");
    });

    it("allows one finalized entry per child, mobile and competition, and nothing more restrictive", async () => {
      const w = await world();
      const first = await finalized(w, { name: "Asha", norm: "asha" });
      // two drafts for the same child may exist side by side
      const second = await draft(w, { name: "Asha", norm: "asha" });
      await video(second);
      await violation(finalize(second), "unique");
      expect(await statusOf(second)).toBe("draft");
      // siblings: another child under the same mobile number
      await finalized(w, { name: "Bala", norm: "bala" });
      // the same child, another guardian mobile
      await finalized(w, { name: "Asha", norm: "asha", mobile: "+919876500031" });
      // the same child in another competition
      const other = await world();
      await finalized(other, { name: "Asha", norm: "asha" });
      // a withdrawn entry makes room for a new one
      await q("UPDATE submissions SET status = 'withdrawn', withdrawn_at = ? WHERE id = ?", [new Date(), first]);
      await finalize(second);
      expect(await statusOf(second)).toBe("finalized");
    });

    it("lets a held entry coexist with the finalized one, but not become finalized beside it", async () => {
      const w = await world();
      await finalized(w, { name: "Asha", norm: "asha" });
      const held = await draft(w, { name: "Asha", norm: "asha" });
      await video(held);
      await q("UPDATE submissions SET status = 'held', submitted_at = ? WHERE id = ?", [new Date(), held]);
      await violation(q("UPDATE submissions SET status = 'finalized', finalized_at = ? WHERE id = ?", [new Date(), held]), "unique");
      await q("UPDATE submissions SET status = 'rejected' WHERE id = ?", [held]);
      expect(await statusOf(held)).toBe("rejected");
    });

    it("follows the status paths draft -> held -> finalized -> withdrawn and refuses every other move", async () => {
      const w = await world();
      const done = await finalized(w);
      await violation(q("UPDATE submissions SET status = 'draft' WHERE id = ?", [done]), "rule");
      await violation(q("UPDATE submissions SET status = 'held' WHERE id = ?", [done]), "rule");
      await violation(q("UPDATE submissions SET status = 'rejected' WHERE id = ?", [done]), "rule");
      await q("UPDATE submissions SET status = 'withdrawn', withdrawn_at = ? WHERE id = ?", [new Date(), done]);
      await violation(q("UPDATE submissions SET status = 'finalized' WHERE id = ?", [done]), "rule"); // withdrawn is final

      const held = await draft(w, { mobile: "+919876500041" });
      await violation(q("UPDATE submissions SET status = 'rejected' WHERE id = ?", [held]), "rule"); // a draft is never rejected, only a held entry is
      await video(held);
      await q("UPDATE submissions SET status = 'held', submitted_at = ? WHERE id = ?", [new Date(), held]);
      await q("UPDATE submissions SET status = 'rejected' WHERE id = ?", [held]);
      await violation(q("UPDATE submissions SET status = 'held' WHERE id = ?", [held]), "rule"); // rejected is final
    });

    it("freezes a submitted entry's identity, consent and competition, and refuses to delete it", async () => {
      const w = await world();
      const id = await finalized(w);
      for (const [column, value] of [["child_name", "Other"], ["child_name_norm", "other"], ["child_age", 7], ["guardian_mobile", "+919000000000"], ["guardian_email", "x@example.org"], ["guardian_name", "Other"], ["guardian_consent_version", "v9"], ["entry_code", "CHANGED01"]] as const) {
        await violation(q(`UPDATE submissions SET ${column} = ? WHERE id = ?`, [value, id]), "rule");
      }
      await q("UPDATE submissions SET updated_at = ? WHERE id = ?", [new Date(), id]); // bookkeeping is still allowed
      await violation(q("DELETE FROM submissions WHERE id = ?", [id]), "rule");
      const plain = await draft(w, { mobile: "+919876500043" });
      await q("DELETE FROM submissions WHERE id = ?", [plain]); // an unfinished entry can be discarded
      await violation(q("DELETE FROM submissions WHERE id = ?", [id]), "rule");
    });
  });

  // ---- recovery -----------------------------------------------------------------------------------------------------------------------
  describe("registration recovery", () => {
    const row = (submissionId: number, token: string, extra: Record<string, string | number | Date | null> = {}) => ({
      submission_id: submissionId, token_sha256: sha256(token), expires_at: new Date(Date.now() + DAY), ...extra,
    });

    it("keeps only a SHA-256 digest of the recovery code", async () => {
      const id = await draft(await world());
      await violation(insert("registration_recovery", row(id, "x", { token_sha256: "K7M2-93QX" })), "check"); // the plain code itself
      await violation(insert("registration_recovery", row(id, "x", { token_sha256: sha256("k7m2").toUpperCase() })), "check");
      await violation(insert("registration_recovery", row(id, "x", { token_sha256: sha256("k7m2").slice(0, 63) })), "check");
      await insert("registration_recovery", row(id, "K7M2-93QX"));
      const columns = (await q<{ name: string }>(dialect === "mysql" ? "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'registration_recovery'" : "SELECT name FROM pragma_table_info('registration_recovery')")).rows.map((r) => String(r.name).toLowerCase());
      expect(columns.filter((c) => c.includes("token") || c.includes("code"))).toEqual(["token_sha256"]);
    });

    it("allows one active code per entry and a unique digest overall", async () => {
      const id = await draft(await world());
      await insert("registration_recovery", row(id, "first"));
      await violation(insert("registration_recovery", row(id, "second")), "unique");
      await q("UPDATE registration_recovery SET revoked_at = ? WHERE submission_id = ?", [new Date(), id]);
      await insert("registration_recovery", row(id, "second")); // the old code is revoked, so a new one may be issued
      const other = await draft(await world());
      await violation(insert("registration_recovery", row(other, "second")), "unique"); // the same digest can never belong to two entries
    });

    it("refuses an expired-on-arrival code, a code both used and revoked, and a code for a missing entry", async () => {
      const id = await draft(await world());
      await violation(insert("registration_recovery", row(id, "late", { expires_at: new Date(Date.now() - DAY) })), "check");
      await violation(insert("registration_recovery", row(id, "both", { used_at: new Date(), revoked_at: new Date() })), "check");
      await violation(insert("registration_recovery", row(999_999_999, "ghost")), "foreign_key");
    });

    it("recovers unfinished entries only", async () => {
      const id = await finalized(await world());
      await violation(insert("registration_recovery", row(id, "too-late")), "rule");
    });
  });

  // ---- answers -------------------------------------------------------------------------------------------------------------------------
  describe("entry answers", () => {
    const answer = (w: { setId: number }, submissionId: number, questionId: number, type: string, values: Record<string, string | number | null>) =>
      insert("entry_answers", { submission_id: submissionId, question_set_id: w.setId, question_id: questionId, question_type: type, ...values });

    it("stores an answer of the right shape for each type, Tamil and four-byte text included", async () => {
      const w = await richWorld();
      const id = await draft(w);
      await answer(w, id, w.ids.short_text!, "short_text", { value_text: "சென்னை 😀" });
      await answer(w, id, w.ids.paragraph!, "paragraph", { value_text: "நீண்ட பதில்\nஇரண்டாவது வரி" });
      await answer(w, id, w.ids.dropdown!, "dropdown", { value_text: "a" });
      await answer(w, id, w.ids.radio!, "radio", { value_text: "b" });
      await answer(w, id, w.ids.checkboxes!, "checkboxes", { value_json: JSON.stringify(["a", "b"]) });
      await answer(w, id, w.ids.number!, "number", { value_number: 12.5 });
      const { rows } = await q<{ question_type: string; value_text: string | null; value_json: unknown; value_number: number | null }>("SELECT question_type, value_text, value_json, value_number FROM entry_answers WHERE submission_id = ? ORDER BY id", [id]);
      expect(rows[0]!.value_text).toBe("சென்னை 😀");
      expect(rows[1]!.value_text).toBe("நீண்ட பதில்\nஇரண்டாவது வரி");
      expect(json(rows[4]!.value_json)).toEqual(["a", "b"]);
      expect(Number(rows[5]!.value_number)).toBe(12.5);
    });

    it.each([
      ["text for a number question", "number", { value_text: "12" }],
      ["a number for a text question", "short_text", { value_number: 3 }],
      ["a list for a text question", "short_text", { value_json: '["a"]' }],
      ["text for a checkbox question", "checkboxes", { value_text: "a" }],
      ["checkbox values that are not a list", "checkboxes", { value_json: '{"a":1}' }],
      ["two kinds of value at once", "short_text", { value_text: "a", value_number: 1 }],
      ["no value at all", "short_text", {}],
      ["an answer to an instruction", "instruction", { value_text: "ok" }],
    ])("refuses %s", async (_label, type, values) => {
      const w = await richWorld();
      await violation(answer(w, await draft(w), w.ids[type]!, type, values as Record<string, string | number | null>), "check");
    });

    it("refuses answers to a question of another set, with the wrong stored type, or for another set's entry", async () => {
      const a = await richWorld();
      const b = await richWorld();
      const entry = await draft(a);
      await violation(answer(a, entry, b.ids.short_text!, "short_text", { value_text: "x" }), "foreign_key"); // question of another competition
      await violation(answer(a, entry, a.ids.short_text!, "paragraph", { value_text: "x" }), "foreign_key"); // type must match the question's
      await violation(answer(b, entry, b.ids.short_text!, "short_text", { value_text: "x" }), "foreign_key"); // set must match the entry's
      await answer(a, entry, a.ids.short_text!, "short_text", { value_text: "x" });
      await violation(answer(a, entry, a.ids.short_text!, "short_text", { value_text: "y" }), "unique"); // one answer per question
    });

    it("keeps snapshots as JSON objects", async () => {
      const w = await richWorld();
      const id = await draft(w);
      await answer(w, id, w.ids.radio!, "radio", { value_text: "a", snapshot_json: JSON.stringify({ prompt_en: "Question", chosen: { code: "a", ta: "அ", en: "A" } }) });
      await violation(answer(w, id, w.ids.dropdown!, "dropdown", { value_text: "a", snapshot_json: "[1]" }), "check");
    });

    it("locks answers once the entry is submitted", async () => {
      const w = await richWorld();
      const id = await draft(w);
      await answer(w, id, w.ids.short_text!, "short_text", { value_text: "before" });
      await q("UPDATE entry_answers SET value_text = 'edited' WHERE submission_id = ?", [id]); // a draft can be edited
      await video(id);
      await finalize(id);
      await violation(answer(w, id, w.ids.paragraph!, "paragraph", { value_text: "late" }), "rule");
      await violation(q("UPDATE entry_answers SET value_text = 'changed' WHERE submission_id = ?", [id]), "rule");
      await violation(q("DELETE FROM entry_answers WHERE submission_id = ?", [id]), "rule");
    });

    it("keeps answers tied to the wording they were given under when a new version is published", async () => {
      const eventId = await event();
      const v1 = await questionSet(eventId, 1, "draft");
      await insert("questions", { question_set_id: v1, position: 1, question_key: "school", type: "short_text", prompt_ta: "பழைய கேள்வி", prompt_en: "Old wording" });
      await q("UPDATE question_sets SET status = 'published', published_at = ? WHERE id = ?", [new Date(), v1]);
      const w1 = { eventId, setId: v1 };
      const q1 = Number((await q<{ id: number }>("SELECT id FROM questions WHERE question_set_id = ?", [v1])).rows[0]!.id);
      const early = await draft(w1);
      await answer(w1, early, q1, "short_text", { value_text: "early answer" });
      await video(early);
      await finalize(early);

      await q("UPDATE question_sets SET status = 'retired', retired_at = ? WHERE id = ?", [new Date(), v1]);
      const v2 = await questionSet(eventId, 2, "draft");
      await insert("questions", { question_set_id: v2, position: 1, question_key: "school", type: "short_text", prompt_ta: "புதிய கேள்வி", prompt_en: "New wording" });
      await q("UPDATE question_sets SET status = 'published', published_at = ? WHERE id = ?", [new Date(), v2]);
      const w2 = { eventId, setId: v2 };
      const q2 = Number((await q<{ id: number }>("SELECT id FROM questions WHERE question_set_id = ?", [v2])).rows[0]!.id);
      const late = await draft(w2, { mobile: "+919876500051" });
      await answer(w2, late, q2, "short_text", { value_text: "late answer" });

      const { rows } = await q<{ code: string; prompt_en: string; value_text: string }>("SELECT s.entry_code AS code, qu.prompt_en AS prompt_en, a.value_text AS value_text FROM entry_answers a JOIN questions qu ON qu.id = a.question_id JOIN submissions s ON s.id = a.submission_id WHERE s.event_id = ? ORDER BY a.id", [eventId]);
      expect(rows.map((r) => [r.prompt_en, r.value_text])).toEqual([["Old wording", "early answer"], ["New wording", "late answer"]]);
      await violation(draft(w1, { mobile: "+919876500052" }), "rule"); // a retired set takes no new entries
      await violation(answer(w1, late, q1, "short_text", { value_text: "mixed" }), "foreign_key"); // and cannot be mixed into another entry
    });
  });

  // ---- duplicate review ------------------------------------------------------------------------------------------------------------
  describe("duplicate reviews", () => {
    const review = (w: World, submissionId: number, matched: number | null, extra: Record<string, string | number | Date | null> = {}) =>
      insert("duplicate_reviews", { event_id: w.eventId, submission_id: submissionId, matched_submission_id: matched, reason: "same_child_mobile_event", ...extra });

    it("holds an entry against the finalized one it matches, and refuses malformed reviews", async () => {
      const w = await world();
      const existing = await finalized(w, { name: "Asha", norm: "asha" });
      const held = await draft(w, { name: "Asha", norm: "asha" });
      await review(w, held, existing);
      expect((await q<{ status: string }>("SELECT status FROM duplicate_reviews WHERE submission_id = ?", [held])).rows[0]!.status).toBe("held");
      await violation(review(w, held, existing), "unique"); // one open review per entry
      const other = await draft(w, { mobile: "+919876500061" });
      await violation(review(w, other, other), "check"); // not against itself
      await violation(review(w, other, existing, { reason: "gut_feeling" }), "check");
      await violation(review(w, other, existing, { status: "maybe" }), "check");
      const elsewhere = await finalized(await world());
      await violation(review(w, other, elsewhere), "foreign_key"); // both entries must be in this competition
      await violation(review({ ...w, eventId: w.eventId + 1000 }, other, existing), "foreign_key");
    });

    it("records who decided and when, and then never changes", async () => {
      const w = await world();
      const existing = await finalized(w, { name: "Asha", norm: "asha" });
      const held = await draft(w, { name: "Asha", norm: "asha" });
      await review(w, held, existing);
      const admin = await staff();
      await violation(q("UPDATE duplicate_reviews SET status = 'approved' WHERE submission_id = ?", [held]), "check"); // a decision names its author
      await violation(q("UPDATE duplicate_reviews SET decided_by = ? WHERE submission_id = ?", [admin, held]), "check");
      await violation(q("UPDATE duplicate_reviews SET status = 'approved', decided_by = 999999999, decided_at = ? WHERE submission_id = ?", [new Date(), held]), "foreign_key");
      await q("UPDATE duplicate_reviews SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE submission_id = ?", [admin, new Date(), "ஒரே குழந்தை / same child", held]);
      await violation(q("UPDATE duplicate_reviews SET status = 'approved' WHERE submission_id = ?", [held]), "rule");
      await violation(q("DELETE FROM duplicate_reviews WHERE submission_id = ?", [held]), "rule");
      await review(w, held, existing); // a decided review no longer blocks a new one
    });

    it("can point at the audit_log row that recorded the decision", async () => {
      const w = await world();
      const held = await draft(w);
      await insert("audit_log", { actor_type: "system", action: "duplicate.held", entity_type: "submission", entity_id: String(held) });
      const auditId = Number((await q<{ id: number }>("SELECT MAX(id) AS id FROM audit_log")).rows[0]!.id);
      await review(w, held, null, { audit_log_id: auditId, reason: "manual", status: "flagged" });
      await violation(review(w, await draft(w, { mobile: "+919876500071" }), null, { audit_log_id: 999_999_999 }), "foreign_key");
    });
  });

  // ---- video uploads -----------------------------------------------------------------------------------------------------------------
  describe("video uploads", () => {
    const upload = (submissionId: number, extra: Record<string, string | number | Date | null> = {}) =>
      insert("video_uploads", { submission_id: submissionId, object_key: randomUUID(), content_type: "video/mp4", declared_bytes: 200_000, expires_at: new Date(Date.now() + HOUR), ...extra });

    it.each([
      ["a type that is not a video", { content_type: "application/pdf" }],
      ["a file under 100 KB", { declared_bytes: 1000 }],
      ["a file over 100 MB", { declared_bytes: 104_857_601 }],
      ["an object key that is a file name", { object_key: "my video.mp4" }],
      ["an upper-case object key", { object_key: randomUUID().toUpperCase() }],
      ["an unknown status", { status: "uploaded" }],
      ["a verified upload with no verification record", { status: "verified" }],
      ["a verification record on an unverified upload", { verified_at: new Date(), verified_bytes: 200_000 }],
      ["an upload that expires before it was issued", { expires_at: new Date(Date.now() - DAY) }],
    ])("refuses %s", async (_label, change) => {
      await violation(upload(await draft(await world()), change), "check");
    });

    it("refuses a repeated object key and a missing entry", async () => {
      const id = await draft(await world());
      const key = randomUUID();
      await upload(id, { object_key: key });
      await violation(upload(id, { object_key: key }), "unique");
      await violation(upload(999_999_999), "foreign_key");
    });

    it("allows one current (verified) video per entry; a replacement supersedes the old one first", async () => {
      const id = await draft(await world());
      await video(id);
      await violation(video(id), "unique");
      const key = (await q<{ object_key: string }>("SELECT object_key FROM video_uploads WHERE submission_id = ?", [id])).rows[0]!.object_key;
      await q("UPDATE video_uploads SET status = 'superseded' WHERE object_key = ?", [key]);
      await video(id);
      expect(await count("SELECT COUNT(*) AS n FROM video_uploads WHERE submission_id = ? AND status = 'verified'", [id])).toBe(1);
    });

    it("follows the upload life cycle and cannot be re-pointed or removed", async () => {
      const id = await draft(await world());
      const key = randomUUID();
      await upload(id, { object_key: key });
      await violation(q("UPDATE video_uploads SET object_key = ? WHERE object_key = ?", [randomUUID(), key]), "rule");
      await violation(q("UPDATE video_uploads SET declared_bytes = 300000 WHERE object_key = ?", [key]), "rule");
      await violation(q("UPDATE video_uploads SET status = 'superseded' WHERE object_key = ?", [key]), "rule"); // issued cannot be superseded
      await q("UPDATE video_uploads SET status = 'verified', verified_at = ?, verified_bytes = 200000 WHERE object_key = ?", [new Date(), key]);
      await violation(q("UPDATE video_uploads SET status = 'issued', verified_at = NULL, verified_bytes = NULL WHERE object_key = ?", [key]), "rule");
      await violation(q("DELETE FROM video_uploads WHERE object_key = ?", [key]), "rule");
    });

    it("takes uploads only for a draft entry, and keeps a submitted entry's video from being replaced", async () => {
      const w = await world();
      const id = await finalized(w);
      await violation(upload(id), "rule");
      const key = (await q<{ object_key: string }>("SELECT object_key FROM video_uploads WHERE submission_id = ?", [id])).rows[0]!.object_key;
      await violation(q("UPDATE video_uploads SET status = 'superseded' WHERE object_key = ?", [key]), "rule");
      await q("UPDATE video_uploads SET status = 'deleted' WHERE object_key = ?", [key]); // an explicit takedown is still possible
    });
  });

  // ---- judging --------------------------------------------------------------------------------------------------------------------------
  describe("judging", () => {
    async function judge(active: 0 | 1 = 1): Promise<number> {
      const id = await staff("judge", active);
      await insert("judge_profiles", { user_id: id, judge_code: `J${next()}-${String(id).padStart(3, "0")}` });
      return id;
    }
    const assign = (judgeId: number, submissionId: number, eventId: number, by: number) =>
      insert("judge_assignments", { judge_id: judgeId, submission_id: submissionId, event_id: eventId, assigned_by: by });

    it("gives a judge profile to judges only, with a well-formed code", async () => {
      const adminId = await staff("admin");
      await violation(insert("judge_profiles", { user_id: adminId, judge_code: "ADMIN-1" }), "foreign_key");
      await violation(insert("judge_profiles", { user_id: adminId, role: "admin", judge_code: "ADMIN-2" }), "check");
      const judgeId = await staff("judge");
      await violation(insert("judge_profiles", { user_id: judgeId, judge_code: "bad code" }), "check");
      await insert("judge_profiles", { user_id: judgeId, judge_code: `JUDGE-${next()}` });
      await violation(insert("judge_profiles", { user_id: judgeId, judge_code: `JUDGE-${next()}` }), "unique");
    });

    it("assigns finalized entries to active judges, once, within their own competition", async () => {
      const w = await world();
      const adminId = await staff();
      const j = await judge();
      const entry = await finalized(w);
      const notYet = await draft(w, { mobile: "+919876500081" });
      await violation(assign(j, notYet, w.eventId, adminId), "rule");
      await violation(assign(j, entry, w.eventId + 1000, adminId), "foreign_key"); // the competition must be the entry's
      await violation(assign(999_999_999, entry, w.eventId, adminId), "foreign_key");
      await assign(j, entry, w.eventId, adminId);
      await violation(assign(j, entry, w.eventId, adminId), "unique");
      const retired = await judge(0);
      await violation(assign(retired, entry, w.eventId, adminId), "rule");
    });

    it("keeps child and guardian data out of every judging table", async () => {
      const sql =
        dialect === "mysql"
          ? "SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name IN ('judge_profiles', 'judge_assignments', 'scores')"
          : "SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.name IN ('judge_profiles', 'judge_assignments', 'scores')";
      const columns = (await q<{ t: string; c: string }>(sql)).rows.map((r) => String(r.c).toLowerCase());
      expect(columns.length).toBeGreaterThan(10);
      expect(columns.filter((c) => /child|guardian|mobile|email|parent|phone/.test(c))).toEqual([]);
    });

    it("scores through an assignment, in range, one score per judge, and locks a final score", async () => {
      const w = await world();
      const adminId = await staff();
      const j = await judge();
      const entry = await finalized(w);
      const stranger = await judge();
      await violation(insert("scores", { judge_id: stranger, submission_id: entry }), "foreign_key"); // no assignment, no score
      await assign(j, entry, w.eventId, adminId);
      await violation(insert("scores", { judge_id: j, submission_id: entry, marks_hundredths: 10_001 }), "check");
      await violation(insert("scores", { judge_id: j, submission_id: entry, marks_hundredths: -1 }), "check");
      await violation(insert("scores", { judge_id: j, submission_id: entry, status: "final" }), "check"); // final needs marks
      await violation(insert("scores", { judge_id: j, submission_id: entry, status: "final", marks_hundredths: 8850 }), "check"); // and a finalized time
      await insert("scores", { judge_id: j, submission_id: entry, marks_hundredths: 7000, comments: "நன்றாக உள்ளது / good" });
      await violation(insert("scores", { judge_id: j, submission_id: entry, marks_hundredths: 7100 }), "unique");
      await q("UPDATE scores SET marks_hundredths = 8850, status = 'final', finalized_at = ? WHERE judge_id = ? AND submission_id = ?", [new Date(), j, entry]);
      await violation(q("UPDATE scores SET marks_hundredths = 9000 WHERE judge_id = ?", [j]), "rule");
      await violation(q("UPDATE scores SET judge_id = ? WHERE judge_id = ?", [stranger, j]), "rule");
      await violation(q("DELETE FROM scores WHERE judge_id = ?", [j]), "rule");
      // only an unlock that names the administrator and the time reopens it
      await violation(q("UPDATE scores SET status = 'draft', finalized_at = NULL WHERE judge_id = ?", [j]), "rule");
      await q("UPDATE scores SET status = 'draft', finalized_at = NULL, unlocked_by = ?, unlocked_at = ? WHERE judge_id = ?", [adminId, new Date(), j]);
      expect(Number((await q<{ m: number }>("SELECT marks_hundredths AS m FROM scores WHERE judge_id = ?", [j])).rows[0]!.m)).toBe(8850);
    });

    it("stops a deactivated judge from starting a new score", async () => {
      const w = await world();
      const adminId = await staff();
      const j = await judge();
      const entry = await finalized(w);
      await assign(j, entry, w.eventId, adminId);
      await q("UPDATE staff_users SET active = 0 WHERE id = ?", [j]);
      await violation(insert("scores", { judge_id: j, submission_id: entry, marks_hundredths: 5000 }), "rule");
    });
  });

  // ---- winners (before publication), outbox, rate limits ------------------------------------------------------------------------------
  describe("winners before publication", () => {
    const winner = (w: World, submissionId: number, place: number, approver: number, extra: Record<string, string | number | null> = {}) =>
      insert("winners", { event_id: w.eventId, submission_id: submissionId, place, display_name: "ஆஷா", approved_by: approver, ...extra });

    it("needs a finalized entry, a place from 1 to 10, one winner per place and per entry, in the entry's competition", async () => {
      const w = await world();
      const adminId = await staff();
      const a = await finalized(w);
      const b = await finalized(w, { name: "Bala", norm: "bala" });
      await violation(winner(w, await draft(w, { mobile: "+919876500091" }), 1, adminId), "rule");
      await violation(winner(w, a, 0, adminId), "check");
      await violation(winner(w, a, 11, adminId), "check");
      await violation(winner(w, a, 1, 999_999_999), "foreign_key");
      await violation(winner({ ...w, eventId: w.eventId + 1000 }, a, 1, adminId), "foreign_key");
      await violation(winner(w, a, 1, adminId, { display_name: "   " }), "check");
      await winner(w, a, 1, adminId);
      await violation(winner(w, b, 1, adminId), "unique");
      await violation(winner(w, a, 2, adminId), "unique");
      await winner(w, b, 2, adminId);
    });

    it("shows nothing publicly until a results time has passed", async () => {
      expect(await count("SELECT COUNT(*) AS n FROM winners")).toBeGreaterThan(0);
      expect(await count("SELECT COUNT(*) AS n FROM published_winners")).toBe(0);
    });
  });

  describe("e-mail outbox and rate limits", () => {
    it("queues one participation e-mail per entry and keeps its state consistent", async () => {
      const id = await finalized(await world());
      await insert("email_outbox", { submission_id: id, kind: "participation" });
      await violation(insert("email_outbox", { submission_id: id, kind: "participation" }), "unique");
      await violation(insert("email_outbox", { submission_id: id, kind: "newsletter" }), "check");
      const other = await finalized(await world());
      await violation(insert("email_outbox", { submission_id: other, kind: "participation", attempts: 9 }), "check");
      await violation(insert("email_outbox", { submission_id: other, kind: "participation", status: "delivered" }), "check");
      await violation(insert("email_outbox", { submission_id: other, kind: "participation", status: "sent" }), "check"); // sent needs a sent time
      await violation(insert("email_outbox", { submission_id: other, kind: "participation", last_error: "unknown" }), "check");
      await insert("email_outbox", { submission_id: other, kind: "participation", status: "sent", sent_at: new Date() });
    });

    it("counts attempts per hashed key and window, and refuses unhashed keys", async () => {
      const window = new Date(Math.floor(Date.now() / 60_000) * 60_000);
      const key = sha256("203.0.113.9");
      await insert("rate_limits", { scope: "recovery.attempt", key_sha256: key, window_start: window });
      await violation(insert("rate_limits", { scope: "recovery.attempt", key_sha256: key, window_start: window }), "unique");
      await q("UPDATE rate_limits SET hits = hits + 1 WHERE scope = ? AND key_sha256 = ? AND window_start = ?", ["recovery.attempt", key, window]);
      expect(Number((await q<{ hits: number }>("SELECT hits FROM rate_limits WHERE key_sha256 = ?", [key])).rows[0]!.hits)).toBe(2);
      await violation(insert("rate_limits", { scope: "recovery.attempt", key_sha256: "203.0.113.9", window_start: window }), "check"); // never the raw address
      await violation(insert("rate_limits", { scope: "Recovery", key_sha256: sha256("x"), window_start: window }), "check");
      await violation(insert("rate_limits", { scope: "recovery.attempt", key_sha256: sha256("y"), window_start: window, hits: 0 }), "check");
    });
  });

  // ---- referential integrity ------------------------------------------------------------------------------------------------------------
  describe("referential integrity", () => {
    it("restricts deletes instead of cascading: nothing disappears because a parent was removed", async () => {
      const w = await world();
      await violation(q("DELETE FROM events WHERE id = ?", [w.eventId]), "foreign_key");
      const adminId = await staff();
      await insert("audit_log", { actor_type: "staff", actor_staff_id: adminId, action: "staff.checked", entity_type: "staff_user" });
      await violation(q("DELETE FROM staff_users WHERE id = ?", [adminId]), "foreign_key");
      const rich = await richWorld();
      const id = await draft(rich);
      await insert("entry_answers", { submission_id: id, question_set_id: rich.setId, question_id: rich.ids.short_text!, question_type: "short_text", value_text: "x" });
      await violation(q("DELETE FROM submissions WHERE id = ?", [id]), "foreign_key");
    });
  });

  // ---- concurrency ---------------------------------------------------------------------------------------------------------------------
  describe("concurrent writers", () => {
    const outcome = async (works: Promise<unknown>[]) => {
      const results = await Promise.all(works.map(caught));
      const failures = results.filter((r) => r !== undefined);
      for (const f of failures) {
        expect(f).toBeInstanceOf(DatabaseError);
        // The loser sees the duplicate key; on MySQL it can instead be chosen as a deadlock victim. Both leave the winner's data intact.
        expect(["constraint", "deadlock", "busy"]).toContain((f as DatabaseError).kind);
      }
      return { wins: results.length - failures.length };
    };

    it("finalizes the same child twice at once: exactly one entry wins", async () => {
      const w = await world();
      const ids: number[] = [];
      for (let i = 0; i < 6; i++) {
        const id = await draft(w, { name: "Asha", norm: "asha" });
        await video(id);
        ids.push(id);
      }
      const { wins } = await outcome(ids.map((id) => db.transaction(async (tx) => void (await tx.query("UPDATE submissions SET status = 'finalized', submitted_at = ?, finalized_at = ? WHERE id = ?", [new Date(), new Date(), id])))));
      expect(wins).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM submissions WHERE event_id = ? AND status = 'finalized'", [w.eventId])).toBe(1);
    });

    it("publishes two question sets of one competition at once: exactly one is published", async () => {
      const eventId = await event();
      const sets = [await questionSet(eventId, 1, "draft"), await questionSet(eventId, 2, "draft"), await questionSet(eventId, 3, "draft")];
      const { wins } = await outcome(sets.map((id) => db.transaction(async (tx) => void (await tx.query("UPDATE question_sets SET status = 'published', published_at = ? WHERE id = ?", [new Date(), id])))));
      expect(wins).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM question_sets WHERE event_id = ? AND status = 'published'", [eventId])).toBe(1);
    });

    it("issues recovery codes for one entry at once: exactly one stays active", async () => {
      const id = await draft(await world());
      const { wins } = await outcome([1, 2, 3, 4].map((i) => db.transaction(async (tx) => void (await tx.query("INSERT INTO registration_recovery (submission_id, token_sha256, expires_at) VALUES (?, ?, ?)", [id, sha256(`race-${i}-${next()}`), new Date(Date.now() + DAY)])))));
      expect(wins).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM registration_recovery WHERE submission_id = ? AND used_at IS NULL AND revoked_at IS NULL", [id])).toBe(1);
    });

    it("reserves a place for two winners at once: exactly one takes it", async () => {
      const w = await world();
      const adminId = await staff();
      const a = await finalized(w);
      const b = await finalized(w, { name: "Bala", norm: "bala" });
      const { wins } = await outcome([a, b].map((id) => db.transaction(async (tx) => void (await tx.query("INSERT INTO winners (event_id, submission_id, place, display_name, approved_by) VALUES (?, ?, 1, 'Winner', ?)", [w.eventId, id, adminId])))));
      expect(wins).toBe(1);
    });

    it("rolls back a failed finalization completely", async () => {
      const w = await world();
      const id = await draft(w);
      await video(id);
      const error = await caught(db.transaction(async (tx) => {
        await tx.query("UPDATE submissions SET status = 'finalized', submitted_at = ?, finalized_at = ? WHERE id = ?", [new Date(), new Date(), id]);
        await tx.query("INSERT INTO email_outbox (submission_id, kind, attempts) VALUES (?, 'participation', 99)", [id]); // refused: attempts above 8
      }));
      expect(error).toMatchObject({ kind: "constraint", constraint: "check" });
      expect(await statusOf(id)).toBe("draft");
      expect(await count("SELECT COUNT(*) AS n FROM email_outbox WHERE submission_id = ?", [id])).toBe(0);
    });
  });

  // ---- the two engines, side by side ----------------------------------------------------------------------------------------------------
  describe("dialect differences (asserted on purpose)", () => {
    it("returns JSON columns parsed on MySQL and as text on SQLite", async () => {
      const w = await richWorld();
      const value = (await q<{ options_json: unknown }>("SELECT options_json FROM questions WHERE id = ?", [w.ids.radio!])).rows[0]!.options_json;
      expect(typeof value).toBe(dialect === "mysql" ? "object" : "string");
      expect(json(value)).toHaveLength(2);
    });

    it("returns timestamps as Date on MySQL and as ISO text on SQLite; asDate() reads both", async () => {
      const raw = (await q<{ created_at: unknown }>("SELECT created_at FROM events LIMIT 1")).rows[0]!.created_at;
      expect(raw instanceof Date).toBe(dialect === "mysql");
      expect(Math.abs(asDate(raw).getTime() - (await dbNow()).getTime())).toBeLessThan(10 * 60_000);
    });

    it("treats a tab inside an e-mail differently: MySQL refuses it, SQLite accepts it (the application validates e-mail addresses)", async () => {
      const attempt = insert("staff_users", { email: `tab\t${next()}@example.org`, password_hash: "h".repeat(60), role: "admin", display_name: "Tab" });
      if (dialect === "mysql") await violation(attempt, "check");
      else await expect(attempt).resolves.toBeUndefined();
    });

    it("counts the generated uniqueness flags the same way: NULL means 'not part of the rule' on both", async () => {
      const w = await world();
      const a = await draft(w, { name: "Asha", norm: "asha" });
      const b = await draft(w, { name: "Asha", norm: "asha" });
      const flags = (await q<{ id: number; finalized_flag: number | null }>("SELECT id, finalized_flag FROM submissions WHERE id IN (?, ?)", [a, b])).rows;
      expect(flags.map((r) => r.finalized_flag)).toEqual([null, null]);
    });
  });

  describe("typed query builder", () => {
    it("reads and writes the schema through Kysely on both engines", async () => {
      const slug = `typed-${next()}`;
      await db.kysely.insertInto("events").values({ slug, name_ta: "தமிழ்", name_en: "Tamil", min_age: 4, max_age: 9 }).execute();
      const row = await db.kysely.selectFrom("events").select(["slug", "name_ta", "min_age", "max_age", "created_at"]).where("slug", "=", slug).executeTakeFirstOrThrow();
      expect(row).toMatchObject({ slug, name_ta: "தமிழ்", min_age: 4, max_age: 9 });
      expect(Math.abs(asDate(row.created_at).getTime() - (await dbNow()).getTime())).toBeLessThan(10 * 60_000);
      const fromView = await db.kysely.selectFrom("published_winners").select("display_name").execute();
      expect(Array.isArray(fromView)).toBe(true);
    });
  });

  // ---- results publication (keep last: it freezes the winners table) ----------------------------------------------------------------
  describe("results publication", () => {
    it("shows approved winners only after the results time, then freezes winners and the time itself", async () => {
      const w = await world();
      const adminId = await staff();
      const entry = await finalized(w);
      await insert("winners", { event_id: w.eventId, submission_id: entry, place: 1, display_name: "ஆஷா", approved_by: adminId });

      const now = await dbNow();
      await q("UPDATE event_settings SET submissions_open_at = ?, submissions_close_at = ?, guardian_consent_version = 'v1', results_publish_at = ? WHERE id = 1", [new Date(now.getTime() - 2 * DAY), new Date(now.getTime() - DAY), new Date(now.getTime() + 2000)]);
      expect(await count("SELECT COUNT(*) AS n FROM published_winners")).toBe(0); // approved, but the time has not come

      await new Promise((resolve) => setTimeout(resolve, 2600));
      const { rows } = await q<Record<string, unknown>>("SELECT * FROM published_winners WHERE event_id = ?", [w.eventId]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ event_id: w.eventId, place: 1, display_name: "ஆஷா" });
      expect(Object.keys(rows[0]!).sort()).toEqual(["award_label", "display_name", "event_id", "event_slug", "id", "place"]); // no entry, child or guardian data

      await violation(q("UPDATE winners SET place = 2 WHERE submission_id = ?", [entry]), "rule");
      await violation(q("DELETE FROM winners WHERE submission_id = ?", [entry]), "rule");
      const late = await finalized(w, { name: "Bala", norm: "bala" });
      await violation(insert("winners", { event_id: w.eventId, submission_id: late, place: 2, display_name: "பாலா", approved_by: adminId }), "rule");
      await violation(q("UPDATE event_settings SET results_publish_at = NULL WHERE id = 1"), "rule"); // published results cannot be withdrawn by editing the time
      await violation(q("UPDATE event_settings SET results_publish_at = ? WHERE id = 1", [new Date(now.getTime() + 30 * DAY)]), "rule");
    }, 30_000);
  });
});
