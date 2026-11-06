import { describe, expect, it, vi } from "vitest";
import { confirmWinner, removeWinner, type EventScoring, type WinnerDb } from "./winners";

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const C = "cccccccc-0000-4000-8000-00000000000c";
const J1 = "11111111-0000-4000-8000-000000000001";
const J2 = "22222222-0000-4000-8000-000000000002";

const fin = (s: string, j: string, marks: number) => ({ submissionId: s, judgeId: j, marks, status: "final" as const });
function setup(data: Partial<EventScoring> = {}, over: Partial<WinnerDb> = {}) {
  const scoring: EventScoring = {
    finalizedIds: [A, B, C],
    assignments: [A, B, C].flatMap((s) => [J1, J2].map((j) => ({ submissionId: s, judgeId: j }))),
    scores: [fin(A, J1, 90), fin(A, J2, 90), fin(B, J1, 80), fin(B, J2, 80), fin(C, J1, 80), fin(C, J2, 80)],
    ...data,
  };
  return {
    eventScoring: vi.fn(async () => scoring),
    insert: vi.fn(async () => undefined),
    remove: vi.fn(async () => 1),
    ...over,
  } satisfies WinnerDb;
}
const ask = (db: WinnerDb, over: Record<string, unknown> = {}) => confirmWinner(db, 3, { submissionId: A, rank: "1", displayName: "Asha", ...over });

describe("confirmWinner", () => {
  it("confirms a fully scored entry with the administrator's own typed name, and publishes nothing", async () => {
    const db = setup();
    expect(await ask(db, { awardLabel: " First prize " })).toEqual({ ok: true });
    expect(db.insert).toHaveBeenCalledExactlyOnceWith({ eventId: 3, submissionId: A, rank: 1, awardLabel: "First prize", displayName: "Asha" });
  });

  it("refuses an entry that is not a finalized entry of this competition", async () => {
    const db = setup();
    expect(await ask(db, { submissionId: "dddddddd-0000-4000-8000-00000000000d" })).toEqual({ ok: false, code: "notFound" });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("refuses an entry until EVERY assigned judge has a final mark", async () => {
    const db = setup({ scores: [fin(A, J1, 90), { submissionId: A, judgeId: J2, marks: 95, status: "draft" }] });
    expect(await ask(db)).toEqual({ ok: false, code: "incomplete" });
    expect(db.insert).not.toHaveBeenCalled();
    expect(await ask(setup({ assignments: [] }))).toEqual({ ok: false, code: "incomplete" });
  });

  it("a tie is flagged: nothing is chosen automatically, and the administrator must say they are deciding it", async () => {
    const db = setup();
    expect(await ask(db, { submissionId: B, rank: "2" })).toEqual({ ok: false, code: "tieNeedsDecision" });
    expect(db.insert).not.toHaveBeenCalled();
    expect(await ask(db, { submissionId: B, rank: "2", acknowledgeTie: true })).toEqual({ ok: true });
    expect(await ask(db, { submissionId: C, rank: "3", acknowledgeTie: true })).toEqual({ ok: true });
    expect(await ask(setup(), { acknowledgeTie: true })).toEqual({ ok: true }); // acknowledging a non-tie is harmless
  });

  it("validates the input: rank 1 to 10, a typed name of 1 to 60 characters, a label up to 80", async () => {
    for (const over of [{ rank: "0" }, { rank: "11" }, { rank: "1.5" }, { rank: "abc" }, { displayName: "" }, { displayName: "   " }, { displayName: "x".repeat(61) }, { awardLabel: "x".repeat(81) }, { submissionId: "nope" }]) {
      const db = setup();
      expect(await ask(db, over), JSON.stringify(over).slice(0, 40)).toEqual({ ok: false, code: "invalid" });
      expect(db.insert).not.toHaveBeenCalled();
    }
    expect(await confirmWinner(setup(), 3, null)).toEqual({ ok: false, code: "invalid" });
  });

  it("maps the database's refusals: rank taken, already a winner, not allowed, anything else", async () => {
    const refuse = (code: string, message: string) => setup({}, { insert: vi.fn(async () => { throw Object.assign(new Error(message), { code }); }) });
    expect(await ask(refuse("23505", 'duplicate key value violates unique constraint "winners_event_id_rank_key"'))).toEqual({ ok: false, code: "rankTaken" });
    expect(await ask(refuse("23505", 'duplicate key value violates unique constraint "winners_submission_id_key" (submission_id)'))).toEqual({ ok: false, code: "alreadyWinner" });
    expect(await ask(refuse("42501", "permission denied"))).toEqual({ ok: false, code: "notAllowed" });
    const generic = await ask(refuse("XX000", "password=hunter2"));
    expect(generic).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(generic)).not.toContain("hunter2");
  });
});

describe("removeWinner", () => {
  it("removes one winner, and reports an unknown one", async () => {
    expect(await removeWinner(setup(), A)).toEqual({ ok: true });
    expect(await removeWinner(setup({}, { remove: vi.fn(async () => 0) }), A)).toEqual({ ok: false, code: "notFound" });
    expect(await removeWinner(setup(), "nope")).toEqual({ ok: false, code: "invalid" });
    expect(await removeWinner(setup({}, { remove: vi.fn(async () => { throw new Error("x"); }) }), A)).toEqual({ ok: false, code: "unavailable" });
  });
});
