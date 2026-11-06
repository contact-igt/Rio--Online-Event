import { beforeEach, describe, expect, it, vi } from "vitest";

// Administrator server actions: only an administrator session works, input is validated, the database refusals are mapped, and
// nothing here can publish results.

const h = vi.hoisted(() => ({ rpc: vi.fn(), admin: true }));
vi.mock("@/lib/staff/auth", () => ({
  staffSession: async (role: string) => (h.admin && role === "admin" ? { user: { id: "ad000000-0000-4000-8000-0000000000ad" }, role, supabase: { rpc: h.rpc } } : null),
}));
const winnerDb = vi.hoisted(() => ({ eventScoring: vi.fn(), insert: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/judging/winners", async (orig) => ({ ...(await orig<typeof import("@/lib/judging/winners")>()), createWinnerDb: () => winnerDb }));

type Actions = typeof import("./actions");
let actions: Actions;
const J = "11111111-0000-4000-8000-000000000001";
const S = "bbbbbbbb-0000-4000-8000-0000000000b1";

beforeEach(async () => {
  vi.resetModules();
  h.admin = true;
  h.rpc.mockReset().mockResolvedValue({ data: 3, error: null });
  winnerDb.eventScoring.mockReset().mockResolvedValue({ finalizedIds: [S], assignments: [{ submissionId: S, judgeId: J }], scores: [{ submissionId: S, judgeId: J, marks: 80, status: "final" }] });
  winnerDb.insert.mockReset().mockResolvedValue(undefined);
  winnerDb.remove.mockReset().mockResolvedValue(1);
  actions = await import("./actions");
});

describe("assignJudge", () => {
  it("only an administrator session works", async () => {
    h.admin = false;
    expect(await actions.assignJudge({ slug: "kutti-pesalar", judgeId: J })).toEqual({ ok: false, code: "notAllowed" });
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("assigns through the database function with the competition's number and reports how many were added", async () => {
    expect(await actions.assignJudge({ slug: "kutti-pesalar", judgeId: J })).toEqual({ ok: true, added: 3 });
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("assign_judge_to_event", { p_judge: J, p_event: 4 });
  });
  it("refuses an unknown competition or a malformed judge id before the database", async () => {
    for (const bad of [{ slug: "nope", judgeId: J }, { slug: "kutti-pesalar", judgeId: "x" }, { slug: 5, judgeId: J }, null, undefined]) {
      expect(await actions.assignJudge(bad as never), JSON.stringify(bad)).toEqual({ ok: false, code: "invalid" });
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("maps the database's refusals and leaks nothing", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: "judge_not_found" } });
    expect(await actions.assignJudge({ slug: "kutti-pesalar", judgeId: J })).toEqual({ ok: false, code: "judgeNotFound" });
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: "forbidden" } });
    expect(await actions.assignJudge({ slug: "kutti-pesalar", judgeId: J })).toEqual({ ok: false, code: "notAllowed" });
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: "deadlock password=hunter2" } });
    const res = await actions.assignJudge({ slug: "kutti-pesalar", judgeId: J });
    expect(res).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(res)).not.toContain("hunter2");
  });
});

describe("confirmWinnerAction and removeWinnerAction", () => {
  const ok = { slug: "kutti-pesalar", submissionId: S, rank: "1", displayName: "Asha" };
  it("only an administrator session works", async () => {
    h.admin = false;
    expect(await actions.confirmWinnerAction(ok)).toEqual({ ok: false, code: "notAllowed" });
    expect(await actions.removeWinnerAction({ winnerId: S })).toEqual({ ok: false, code: "notAllowed" });
    expect(winnerDb.insert).not.toHaveBeenCalled();
    expect(winnerDb.remove).not.toHaveBeenCalled();
  });
  it("confirms for the page's competition after the scoring checks", async () => {
    expect(await actions.confirmWinnerAction(ok)).toEqual({ ok: true });
    expect(winnerDb.eventScoring).toHaveBeenCalledExactlyOnceWith(4);
    expect(winnerDb.insert).toHaveBeenCalledExactlyOnceWith({ eventId: 4, submissionId: S, rank: 1, awardLabel: null, displayName: "Asha" });
  });
  it("refuses an unknown competition", async () => {
    expect(await actions.confirmWinnerAction({ ...ok, slug: "nope" })).toEqual({ ok: false, code: "invalid" });
    expect(winnerDb.eventScoring).not.toHaveBeenCalled();
  });
  it("removes a winner", async () => {
    expect(await actions.removeWinnerAction({ winnerId: S })).toEqual({ ok: true });
  });
  it("contains no way to publish: the module never mentions the publication setting", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(new URL("./actions.ts", import.meta.url), "utf8")).not.toMatch(/results_publish_at|submissions_open_at|service_role|createAdminClient/);
  });
});
