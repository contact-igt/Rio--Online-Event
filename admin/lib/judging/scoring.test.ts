import { describe, expect, it, vi } from "vitest";
import { saveScore, type ScoreDb } from "./scoring";

const ENTRY = "bbbbbbbb-0000-4000-8000-0000000000b1";

function setup(existing: { id: string; status: "draft" | "final" } | null = null, over: Partial<ScoreDb> = {}) {
  const db = {
    find: vi.fn(async () => existing),
    insert: vi.fn(async () => undefined),
    update: vi.fn(async () => 1),
    ...over,
  } satisfies ScoreDb;
  return db;
}
const save = (db: ScoreDb, over: Record<string, unknown> = {}) => saveScore(db, { entryId: ENTRY, marks: "72.5", comments: "Good", final: false, ...over });

describe("saveScore", () => {
  it("creates a draft the first time and updates the same row afterwards (never a second row)", async () => {
    const first = setup();
    expect(await save(first)).toEqual({ ok: true, status: "draft" });
    expect(first.insert).toHaveBeenCalledExactlyOnceWith({ submissionId: ENTRY, marks: 72.5, comments: "Good", status: "draft" });
    const again = setup({ id: "s1", status: "draft" });
    expect(await save(again, { marks: "80" })).toEqual({ ok: true, status: "draft" });
    expect(again.insert).not.toHaveBeenCalled();
    expect(again.update).toHaveBeenCalledExactlyOnceWith("s1", { marks: 80, comments: "Good", status: "draft" });
  });

  it("a final score needs marks; a draft may have none", async () => {
    expect(await save(setup(), { marks: "", final: true })).toEqual({ ok: false, code: "marksRequired" });
    const draft = setup();
    expect(await save(draft, { marks: "", comments: "" })).toEqual({ ok: true, status: "draft" });
    expect(draft.insert).toHaveBeenCalledExactlyOnceWith({ submissionId: ENTRY, marks: null, comments: null, status: "draft" });
    expect(await save(setup(), { final: true })).toEqual({ ok: true, status: "final" });
  });

  it("refuses marks outside 0 to 100, with more than two decimals, or not a number, without touching the database", async () => {
    for (const marks of ["101", "-1", "12.345", "abc", "1e2", "5,5"]) {
      const db = setup();
      expect(await save(db, { marks }), marks).toEqual({ ok: false, code: "invalid" });
      expect(db.find).not.toHaveBeenCalled();
    }
  });

  it("refuses a malformed entry id, over-long comments and a non-boolean final", async () => {
    for (const over of [{ entryId: "nope" }, { entryId: null }, { comments: "x".repeat(2001) }, { final: "yes" }]) {
      const db = setup();
      expect(await save(db, over), JSON.stringify(over).slice(0, 40)).toEqual({ ok: false, code: "invalid" });
      expect(db.find).not.toHaveBeenCalled();
    }
  });

  it("a final score is locked: no second write of any kind", async () => {
    const db = setup({ id: "s1", status: "final" });
    expect(await save(db, { marks: "99", final: true })).toEqual({ ok: false, code: "locked" });
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("maps the database's refusals: not assigned or not finalized, a lost race, a lock, and anything else", async () => {
    const refuse = (code: string) => setup(null, { insert: vi.fn(async () => { throw Object.assign(new Error("database"), { code }); }) });
    expect(await save(refuse("42501"))).toEqual({ ok: false, code: "notAllowed" });
    expect(await save(refuse("23505"))).toEqual({ ok: false, code: "conflict" });
    expect(await save(refuse("XX000"))).toEqual({ ok: false, code: "unavailable" });
    expect(await save(setup({ id: "s1", status: "draft" }, { update: vi.fn(async () => 0) }))).toEqual({ ok: false, code: "notAllowed" });
  });

  it("never echoes a database error", async () => {
    const db = setup(null, { find: vi.fn(async () => { throw Object.assign(new Error("password=hunter2"), { code: "XX000" }); }) });
    expect(JSON.stringify(await save(db))).not.toContain("hunter2");
  });
});
