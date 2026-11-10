import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseAdapter, Dialect } from "./adapter.ts";
import { COMPETITIONS } from "./seed/competitions.ts";
import { applySeed, planSeed, SeedConflict } from "./seed-events.ts";
import { dialects, openTestDatabase } from "./test-db.ts";
import { dropAppSchema, installAppSchema } from "./test-schema.ts";

const TRACKING = "zz_seed_migrations";
const WEBSITE_EVENTS = join(import.meta.dirname, "../../../website/lib/events.ts");

describe("the approved list", () => {
  it("is exactly what website/lib/events.ts says: same slugs, order, names and age ranges (a change on either side fails this test)", () => {
    if (!existsSync(WEBSITE_EVENTS)) return; // the backend can be checked out on its own
    const source = readFileSync(WEBSITE_EVENTS, "utf8");
    const web = [...source.matchAll(/number:\s*(\d+),\s*slug:\s*"([^"]+)",\s*nameTa:\s*"([^"]+)",\s*nameEn:\s*"([^"]+)",\s*minAge:\s*(\d+),\s*maxAge:\s*(\d+)/g)].map((m) => ({
      number: Number(m[1]), slug: m[2], nameTa: m[3], nameEn: m[4], minAge: Number(m[5]), maxAge: Number(m[6]),
    }));
    expect(web).toHaveLength(6);
    expect(COMPETITIONS).toEqual(web);
  });

  it("has six competitions with unique slugs that satisfy the database's slug rule, and sensible age ranges", () => {
    expect(COMPETITIONS.map((c) => c.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(COMPETITIONS.map((c) => c.slug)).size).toBe(6);
    for (const c of COMPETITIONS) {
      expect(c.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(c.minAge).toBeGreaterThanOrEqual(3);
      expect(c.maxAge).toBeLessThanOrEqual(12);
      expect(c.minAge).toBeLessThanOrEqual(c.maxAge);
    }
  });
});

describe.each(dialects)("%s competition seed", (dialect: Dialect) => {
  let db: DatabaseAdapter;
  const q = <Row = Record<string, unknown>>(sql: string, params: readonly (string | number | Date | null)[] = []) => db.query<Row>(sql, params);
  const count = async (table: string) => Number((await q<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]!.n);
  const fresh = async () => installAppSchema(db, TRACKING);

  it("opens the database", async () => {
    db = openTestDatabase(dialect);
    await fresh();
  }, 120_000);
  afterAll(async () => {
    await dropAppSchema(db, TRACKING);
    await db.close();
  });

  it("plans six creations on an empty table without writing anything", async () => {
    await fresh();
    const plan = await planSeed(db);
    expect(plan.toCreate.map((c) => c.slug)).toEqual(COMPETITIONS.map((c) => c.slug));
    expect(plan).toMatchObject({ unchanged: [], conflicts: [], others: [] });
    expect(await count("events")).toBe(0);
    expect(await count("audit_log")).toBe(0);
  });

  it("creates the six competitions exactly, in poster order, active, with one audit row", async () => {
    await fresh();
    const now = new Date();
    const result = await applySeed(db, now);
    expect(result.created).toHaveLength(6);
    const rows = (await q<{ slug: string; name_ta: string; name_en: string; min_age: number; max_age: number; display_order: number; active: number }>("SELECT slug, name_ta, name_en, min_age, max_age, display_order, active FROM events ORDER BY display_order")).rows;
    expect(rows.map((r) => ({ number: Number(r.display_order), slug: r.slug, nameTa: r.name_ta, nameEn: r.name_en, minAge: Number(r.min_age), maxAge: Number(r.max_age) }))).toEqual(COMPETITIONS);
    expect(rows.every((r) => Number(r.active) === 1)).toBe(true);
    const audit = (await q<{ actor_type: string; action: string; details: unknown }>("SELECT actor_type, action, details FROM audit_log")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: "system", action: "events.seeded" });
    const details = audit[0]!.details;
    expect(typeof details === "string" ? JSON.parse(details) : details).toMatchObject({ created: 6, already_present: 0 });
  });

  it("writes nothing but events and one audit row: no questions, no question sets, no settings change, no entries", async () => {
    await fresh();
    await applySeed(db, new Date());
    for (const table of ["question_sets", "questions", "submissions", "registration_recovery", "entry_answers", "duplicate_reviews", "video_uploads", "staff_users", "staff_sessions", "rate_limits", "winners"]) {
      expect(await count(table), table).toBe(0);
    }
    const settings = (await q("SELECT submissions_open_at, submissions_close_at, results_publish_at, guardian_consent_version, media_consent_version FROM event_settings")).rows[0]!;
    expect(Object.values(settings).every((v) => v === null)).toBe(true); // registration stays closed
  });

  it("is idempotent: a second run creates nothing and adds no audit row", async () => {
    await fresh();
    await applySeed(db, new Date());
    const again = await applySeed(db, new Date());
    expect(again).toMatchObject({ created: [], unchanged: COMPETITIONS.map((c) => c.slug) });
    expect(await count("events")).toBe(6);
    expect(await count("audit_log")).toBe(1);
  });

  it("completes a partly seeded table without touching what is there", async () => {
    await fresh();
    const first = COMPETITIONS[0]!;
    await q("INSERT INTO events (slug, name_ta, name_en, min_age, max_age, display_order, active) VALUES (?, ?, ?, ?, ?, 99, 0)", [first.slug, first.nameTa, first.nameEn, first.minAge, first.maxAge]);
    const result = await applySeed(db, new Date());
    expect(result.created).toEqual(COMPETITIONS.slice(1).map((c) => c.slug));
    expect(await count("events")).toBe(6);
    const kept = (await q<{ display_order: number; active: number }>("SELECT display_order, active FROM events WHERE slug = ?", [first.slug])).rows[0]!;
    expect([Number(kept.display_order), Number(kept.active)]).toEqual([99, 0]); // an organizer's order and switch are not overwritten
  });

  it("leaves competitions an organizer added alone, and says so", async () => {
    await fresh();
    await q("INSERT INTO events (slug, name_ta, name_en, min_age, max_age) VALUES ('organizer-special', 'சிறப்பு', 'Special', 4, 9)");
    const result = await applySeed(db, new Date());
    expect(result.others).toEqual(["organizer-special"]);
    expect(await count("events")).toBe(7);
    expect((await q<{ name_en: string }>("SELECT name_en FROM events WHERE slug = 'organizer-special'")).rows[0]!.name_en).toBe("Special");
  });

  it.each([
    ["an age range", "UPDATE events SET max_age = 9 WHERE slug = 'kutti-pesalar'", ["max_age"]],
    ["a Tamil name", "UPDATE events SET name_ta = 'வேறு' WHERE slug = 'kutti-pesalar'", ["name_ta"]],
    ["an English name", "UPDATE events SET name_en = 'Different' WHERE slug = 'kutti-pesalar'", ["name_en"]],
  ])("stops without writing anything when an existing competition has %s that differs", async (_label, change, fields) => {
    await fresh();
    await applySeed(db, new Date());
    await q("DELETE FROM events WHERE slug = 'tamilil-sollu'"); // a missing competition that would otherwise be created
    await q(change);
    const before = await count("audit_log");
    const error = await applySeed(db, new Date()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeedConflict);
    expect((error as SeedConflict).conflicts).toEqual([{ slug: "kutti-pesalar", fields }]);
    expect(await count("events")).toBe(5); // the missing one was NOT created: all or nothing
    expect(await count("audit_log")).toBe(before);
  });

  it("does not alter an existing competition that has entries attached (nothing to attach to yet is fine: it only ever inserts)", async () => {
    await fresh();
    await applySeed(db, new Date());
    const ids = (await q<{ id: number }>("SELECT id FROM events ORDER BY id")).rows.map((r) => Number(r.id));
    await applySeed(db, new Date());
    expect((await q<{ id: number }>("SELECT id FROM events ORDER BY id")).rows.map((r) => Number(r.id))).toEqual(ids); // same rows, same ids
  });
});

describe("the seed command (a real child process, SQLite file)", () => {
  const folder = mkdtempSync(join(tmpdir(), "rio-seed-"));
  const path = join(folder, "seed.test.sqlite");
  afterAll(() => {
    try {
      rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows can briefly hold a SQLite file; a leftover temporary folder is harmless
    }
  });
  const cli = (command: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, command), ...args], { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", DB_DIALECT: "sqlite", SQLITE_PATH: path }, encoding: "utf8" });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  const events = () => {
    const d = new DatabaseSync(path, { readOnly: true });
    const n = (d.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    d.close();
    return n;
  };

  it("refuses an unmigrated database and writes nothing", () => {
    cli("cli.ts", "status"); // creates nothing
    const r = cli("seed-events-cli.ts");
    expect(r.code).toBe(1);
    expect(r.out).toContain("not ready: migrations_missing");
    expect(existsSync(path) && (() => { try { return events(); } catch { return 0; } })() > 0).toBe(false);
  });

  it("--dry-run shows the plan and writes nothing; the real run creates six; the next run does nothing", () => {
    expect(cli("cli.ts", "migrate").code).toBe(0);
    const dry = cli("seed-events-cli.ts", "--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("to create: 6");
    expect(dry.out).toContain("dry run: nothing was written.");
    expect(events()).toBe(0);
    const real = cli("seed-events-cli.ts");
    expect(real.code).toBe(0);
    expect(real.out).toContain("Created 6 competition(s).");
    expect(events()).toBe(6);
    const again = cli("seed-events-cli.ts");
    expect(again.out).toContain("Nothing to do: all six competitions are already present.");
    expect(events()).toBe(6);
  });

  it("stops on a conflict and says which field, without writing", () => {
    const d = new DatabaseSync(path);
    d.exec("UPDATE events SET min_age = 4 WHERE slug = 'malalai-mozhi'; DELETE FROM events WHERE slug = 'tamilil-sollu'");
    d.close();
    const r = cli("seed-events-cli.ts");
    expect(r.code).toBe(1);
    expect(r.out).toContain("CONFLICT malalai-mozhi: min_age differ");
    expect(r.out).toContain("Stopped: nothing was written.");
    expect(events()).toBe(5);
  });

  it("refuses to run in production and never opens the database", () => {
    const env = { PATH: process.env.PATH ?? "", NODE_ENV: "production", DB_DIALECT: "mysql", DATABASE_URL: "mysql://u:s3cret-pw@db.internal:3306/rio", DB_ALLOWED_HOST: "db.internal", ALLOWED_ORIGINS: "https://admin.example.org" };
    const r = spawnSync(process.execPath, [join(import.meta.dirname, "seed-events-cli.ts")], { env, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Seeding is for local development");
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/s3cret|db\.internal/);
  });
});
