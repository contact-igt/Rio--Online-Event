import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseAdapter, Dialect } from "./adapter.ts";
import { loadMigrations, migrate } from "./migrate.ts";
import { dialects, openTestDatabase } from "./test-db.ts";
import { dropAppSchema, migrationsDir } from "./test-schema.ts";

// Migration 0011 makes submissions.guardian_email optional. MySQL does it with ALTER TABLE; SQLite has to rebuild the table (it cannot drop
// NOT NULL). This test applies 0001 to 0010, fills a database with a complete graph of related rows, applies 0011, and checks that nothing
// was lost or loosened: rows, ids, child rows, constraints, generated columns, indexes and triggers.

const TRACKING = "zz_migration_0011";
const HOUR = 3_600_000;
const caught = async (work: Promise<unknown>): Promise<unknown> => work.then(() => undefined, (error: unknown) => error);

describe.each(dialects)("%s migration 0011 (optional guardian e-mail)", (dialect: Dialect) => {
  let db: DatabaseAdapter;
  const q = <Row = Record<string, unknown>>(sql: string, params: readonly (string | number | Date | null)[] = []) => db.query<Row>(sql, params);
  const scalar = async (sql: string, params: readonly (string | number | Date | null)[] = []) => Number((await q<{ n: number }>(sql, params)).rows[0]!.n);

  beforeAll(async () => {
    db = openTestDatabase(dialect);
    await dropAppSchema(db, TRACKING);
    const all = await loadMigrations(migrationsDir(dialect));
    expect(all.map((m) => m.version).slice(-2)).toEqual(["0010", "0011"]);
    await migrate(db, all.filter((m) => m.version <= "0010"), TRACKING);

    // A database as it stood after M2B: one competition and set, a finalized entry with everything attached to it, and a draft.
    const now = new Date();
    await q("INSERT INTO staff_users (email, password_hash, role, display_name, must_change_password, created_at) VALUES ('admin@example.org', ?, 'admin', 'A', 0, ?)", ["h".repeat(60), now]);
    await q("INSERT INTO events (slug, name_ta, name_en, min_age, max_age) VALUES ('old-contest', 'போட்டி', 'Contest', 3, 12)");
    await q("INSERT INTO question_sets (event_id, version) VALUES (1, 1)");
    await q("INSERT INTO questions (question_set_id, position, question_key, type, prompt_ta, prompt_en) VALUES (1, 1, 'school', 'short_text', 'பள்ளி', 'School')");
    await q("UPDATE question_sets SET status = 'published', published_at = ? WHERE id = 1", [now]);
    const entry = (code: string, name: string, mobile: string, email: string) =>
      q(
        "INSERT INTO submissions (entry_code, event_id, question_set_id, child_name, child_name_norm, child_age, guardian_name, guardian_mobile, guardian_email, guardian_consent_version, guardian_consent_at, created_at, updated_at) VALUES (?, 1, 1, ?, ?, 6, 'G', ?, ?, 'v1', ?, ?, ?)",
        [code, name, name.toLowerCase(), mobile, email, now, now, now],
      );
    await entry("OLDENTRY01", "Asha", "+919876543210", "guardian@example.org");
    await entry("OLDENTRY02", "கீர்த்தனா", "+919876543211", "other@example.org");
    await q("INSERT INTO entry_answers (submission_id, question_set_id, question_id, question_type, value_text) VALUES (1, 1, 1, 'short_text', 'அரசு பள்ளி')");
    await q("INSERT INTO registration_recovery (submission_id, token_sha256, expires_at) VALUES (2, ?, ?)", ["a".repeat(64), new Date(now.getTime() + HOUR)]);
    await q("INSERT INTO video_uploads (submission_id, object_key, content_type, declared_bytes, status, expires_at, verified_at, verified_bytes) VALUES (1, ?, 'video/mp4', 200000, 'verified', ?, ?, 200000)", [randomUUID(), new Date(now.getTime() + HOUR), now]);
    await q("UPDATE submissions SET status = 'finalized', submitted_at = ?, finalized_at = ? WHERE id = 1", [now, now]);
    await q("INSERT INTO email_outbox (submission_id, kind) VALUES (1, 'participation')");
    await q("INSERT INTO staff_users (email, password_hash, role, display_name, must_change_password, created_at) VALUES ('judge@example.org', ?, 'judge', 'J', 0, ?)", ["h".repeat(60), now]);
    await q("INSERT INTO judge_profiles (user_id, judge_code) VALUES (2, 'JUDGE-1')");
    await q("INSERT INTO judge_assignments (judge_id, submission_id, event_id, assigned_by) VALUES (2, 1, 1, 1)");
    await q("INSERT INTO scores (judge_id, submission_id, marks_hundredths) VALUES (2, 1, 7000)");
    await q("INSERT INTO duplicate_reviews (event_id, submission_id, matched_submission_id, status, reason) VALUES (1, 2, 1, 'flagged', 'same_child_mobile_event')");

    expect(await migrate(db, all, TRACKING)).toEqual({ applied: ["0011"] });
  }, 120_000);
  afterAll(async () => {
    await dropAppSchema(db, TRACKING);
    await db.close();
  });

  it("keeps every row, id and value, and every row that points at them", async () => {
    const rows = (await q<{ id: number; entry_code: string; child_name: string; guardian_email: string | null; status: string; finalized_flag: number | null }>("SELECT id, entry_code, child_name, guardian_email, status, finalized_flag FROM submissions ORDER BY id")).rows;
    expect(rows.map((r) => [Number(r.id), r.entry_code, r.child_name, r.guardian_email, r.status])).toEqual([
      [1, "OLDENTRY01", "Asha", "guardian@example.org", "finalized"],
      [2, "OLDENTRY02", "கீர்த்தனா", "other@example.org", "draft"],
    ]);
    expect(rows.map((r) => (r.finalized_flag === null ? null : Number(r.finalized_flag)))).toEqual([1, null]); // the generated column still follows the status
    for (const [table, expected] of [["entry_answers", 1], ["registration_recovery", 1], ["video_uploads", 1], ["email_outbox", 1], ["judge_assignments", 1], ["scores", 1], ["duplicate_reviews", 1]] as const) {
      expect(await scalar(`SELECT COUNT(*) AS n FROM ${table}`), table).toBe(expected);
    }
    expect((await q<{ value_text: string }>("SELECT a.value_text FROM entry_answers a JOIN submissions s ON s.id = a.submission_id WHERE s.entry_code = 'OLDENTRY01'")).rows[0]!.value_text).toBe("அரசு பள்ளி");
  });

  it("keeps the other tables' foreign keys pointing at the new table", async () => {
    await expect(q("INSERT INTO registration_recovery (submission_id, token_sha256, expires_at) VALUES (999999, ?, ?)", ["b".repeat(64), new Date(Date.now() + HOUR)])).rejects.toMatchObject({ constraint: "foreign_key" });
    await expect(q("DELETE FROM submissions WHERE id = 2")).rejects.toMatchObject({ constraint: "foreign_key" }); // the draft has a recovery code and a review
    if (dialect === "sqlite") expect((await q("PRAGMA foreign_key_check")).rows).toEqual([]);
  });

  it("keeps new ids going up from where they were", async () => {
    await q("INSERT INTO submissions (entry_code, event_id, question_set_id, child_name, child_name_norm, child_age, guardian_name, guardian_mobile) VALUES ('NEWENTRY01', 1, 1, 'Bala', 'bala', 6, 'G', '+919876543299')");
    expect(Number((await q<{ id: number }>("SELECT id FROM submissions WHERE entry_code = 'NEWENTRY01'")).rows[0]!.id)).toBe(3);
  });

  it("makes the e-mail address optional, and still checks it when it is given", async () => {
    const row = (code: string, email: string | null) =>
      q("INSERT INTO submissions (entry_code, event_id, question_set_id, child_name, child_name_norm, child_age, guardian_name, guardian_mobile, guardian_email) VALUES (?, 1, 1, 'C', 'c', 6, 'G', '+919876543288', ?)", [code, email]);
    await row("NOEMAIL001", null);
    await expect(row("BADEMAIL01", "Upper@Example.org")).rejects.toMatchObject({ constraint: "check" });
    await expect(row("BADEMAIL02", "two@@example.org")).rejects.toMatchObject({ constraint: "check" });
  });

  it("keeps the rule that a submitted entry cannot be edited, including the null-safe e-mail comparison", async () => {
    await expect(q("UPDATE submissions SET child_name = 'Changed' WHERE id = 1")).rejects.toMatchObject({ constraint: "rule" });
    await expect(q("UPDATE submissions SET guardian_email = NULL WHERE id = 1")).rejects.toMatchObject({ constraint: "rule" }); // value -> NULL
    await q("UPDATE submissions SET guardian_email = NULL WHERE entry_code = 'NOEMAIL001'"); // a draft may change it
    await q("UPDATE submissions SET status = 'held', submitted_at = ? WHERE entry_code = 'NOEMAIL001'", [new Date()]).catch(() => undefined); // needs a video: refused
    expect((await q<{ status: string }>("SELECT status FROM submissions WHERE entry_code = 'NOEMAIL001'")).rows[0]!.status).toBe("draft");
  });

  it("freezes a NULL e-mail too: NULL -> value on a submitted entry is an edit (the old comparison missed it)", async () => {
    await q("INSERT INTO submissions (entry_code, event_id, question_set_id, child_name, child_name_norm, child_age, guardian_name, guardian_mobile, guardian_consent_version, guardian_consent_at) VALUES ('FROZENNULL1', 1, 1, 'Dee', 'dee', 6, 'G', '+919876543277', 'v1', ?)", [new Date()]);
    const id = Number((await q<{ id: number }>("SELECT id FROM submissions WHERE entry_code = 'FROZENNULL1'")).rows[0]!.id);
    await q("INSERT INTO video_uploads (submission_id, object_key, content_type, declared_bytes, status, expires_at, verified_at, verified_bytes) VALUES (?, ?, 'video/mp4', 200000, 'verified', ?, ?, 200000)", [id, randomUUID(), new Date(Date.now() + HOUR), new Date()]);
    await q("UPDATE submissions SET status = 'finalized', submitted_at = ?, finalized_at = ? WHERE id = ?", [new Date(), new Date(), id]);
    expect(await caught(q("UPDATE submissions SET guardian_email = 'late@example.org' WHERE id = ?", [id]))).toMatchObject({ constraint: "rule" });
  });

  it("keeps the one-finalized-entry rule, the age rule, the video rule and the delete rule", async () => {
    await q("INSERT INTO submissions (entry_code, event_id, question_set_id, child_name, child_name_norm, child_age, guardian_name, guardian_mobile, guardian_consent_version, guardian_consent_at) VALUES ('SAMEKID001', 1, 1, 'Asha', 'asha', 6, 'G', '+919876543210', 'v1', ?)", [new Date()]);
    const id = Number((await q<{ id: number }>("SELECT id FROM submissions WHERE entry_code = 'SAMEKID001'")).rows[0]!.id);
    await expect(q("UPDATE submissions SET status = 'finalized', submitted_at = ?, finalized_at = ? WHERE id = ?", [new Date(), new Date(), id])).rejects.toMatchObject({ constraint: "rule" }); // no video yet
    await q("INSERT INTO video_uploads (submission_id, object_key, content_type, declared_bytes, status, expires_at, verified_at, verified_bytes) VALUES (?, ?, 'video/mp4', 200000, 'verified', ?, ?, 200000)", [id, randomUUID(), new Date(Date.now() + HOUR), new Date()]);
    await expect(q("UPDATE submissions SET status = 'finalized', submitted_at = ?, finalized_at = ? WHERE id = ?", [new Date(), new Date(), id])).rejects.toMatchObject({ constraint: "unique" });
    await expect(q("INSERT INTO submissions (entry_code, event_id, question_set_id, child_name, child_name_norm, child_age, guardian_name, guardian_mobile) VALUES ('TOOYOUNG01', 1, 1, 'Tiny', 'tiny', 1, 'G', '+919876543266')")).rejects.toMatchObject({ constraint: "rule" });
    await expect(q("DELETE FROM submissions WHERE id = 1")).rejects.toMatchObject({ constraint: "rule" });
  });

  it("keeps its indexes and, on SQLite, its settings for later migrations", async () => {
    if (dialect === "sqlite") {
      const names = (await q<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'submissions'")).rows.map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining(["submissions_mobile_idx", "submissions_event_status_idx"]));
      const triggers = (await q<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'submissions' ORDER BY name")).rows.map((r) => r.name);
      expect(triggers).toEqual(["submissions_guard_delete", "submissions_guard_insert", "submissions_guard_update", "submissions_require_video"]);
      expect((await q<{ legacy_alter_table: number }>("PRAGMA legacy_alter_table")).rows[0]).toEqual({ legacy_alter_table: 0 }); // the migration put it back
      expect((await q<{ foreign_keys: number }>("PRAGMA foreign_keys")).rows[0]).toEqual({ foreign_keys: 1 });
    } else {
      const columns = (await q<{ nullable: string }>("SELECT is_nullable AS nullable FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'submissions' AND column_name = 'guardian_email'")).rows;
      expect(columns[0]!.nullable).toBe("YES");
      const names = (await q<{ n: string }>("SELECT index_name AS n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'submissions'")).rows.map((r) => r.n);
      expect(names).toEqual(expect.arrayContaining(["submissions_mobile_idx", "submissions_event_status_idx", "submissions_one_finalized_uq"]));
    }
  });
});
