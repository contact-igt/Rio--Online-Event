import { beforeEach, describe, expect, it, vi } from "vitest";

// Judge server actions: the playback switch comes first, the session must be an active judge, limits apply, and nothing leaks.

const h = vi.hoisted(() => ({
  session: { user: { id: "11111111-0000-4000-8000-000000000001" }, role: "judge", supabase: {} } as { user: { id: string } } | null,
  available: true,
  lookups: 0,
  throwOnDeps: false,
  deps: { authorize: vi.fn(), store: { presignGet: vi.fn() } },
}));

vi.mock("@/lib/staff/auth", () => ({
  staffSession: async () => {
    h.lookups++;
    return h.session;
  },
}));
vi.mock("@/lib/judging/server", () => ({
  playbackAvailable: () => h.available,
  createPlaybackDeps: () => {
    if (h.throwOnDeps) throw new Error("SECRET-DETAIL sb_secret_leak");
    return h.deps;
  },
}));
const scoreDb = vi.hoisted(() => ({ find: vi.fn(), insert: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/judging/scoring", async (orig) => ({ ...(await orig<typeof import("@/lib/judging/scoring")>()), createScoreDb: () => scoreDb }));

type Actions = typeof import("./actions");
let actions: Actions;
const ENTRY = "bbbbbbbb-0000-4000-8000-0000000000b1";
const VIDEO = "cccccccc-0000-4000-8000-0000000000c1";

beforeEach(async () => {
  vi.resetModules();
  h.session = { user: { id: "11111111-0000-4000-8000-000000000001" } };
  h.available = true;
  h.lookups = 0;
  h.throwOnDeps = false;
  h.deps.authorize.mockReset().mockResolvedValue(VIDEO);
  h.deps.store.presignGet.mockReset().mockResolvedValue("https://acct.r2.test/signed");
  scoreDb.find.mockReset().mockResolvedValue(null);
  scoreDb.insert.mockReset().mockResolvedValue(undefined);
  scoreDb.update.mockReset().mockResolvedValue(1);
  actions = await import("./actions");
});

describe("getPlaybackUrl", () => {
  it("with playback switched off nothing else runs: not even a session lookup", async () => {
    h.available = false;
    expect(await actions.getPlaybackUrl({ entryId: ENTRY })).toEqual({ ok: false, code: "unavailable" });
    expect(h.lookups).toBe(0);
    expect(h.deps.authorize).not.toHaveBeenCalled();
    expect(h.deps.store.presignGet).not.toHaveBeenCalled();
  });

  it("someone who is not an active judge gets nothing signed", async () => {
    h.session = null;
    expect(await actions.getPlaybackUrl({ entryId: ENTRY })).toEqual({ ok: false, code: "notFound" });
    expect(h.deps.authorize).not.toHaveBeenCalled();
  });

  it("uses the judge from the verified session, never from the request", async () => {
    const res = await actions.getPlaybackUrl({ entryId: ENTRY, judgeId: "99999999-0000-4000-8000-000000000009" } as never);
    expect(res.ok).toBe(true);
    expect(h.deps.authorize).toHaveBeenCalledExactlyOnceWith("11111111-0000-4000-8000-000000000001", ENTRY);
  });

  it("limits each judge to 40 links per 10 minutes", async () => {
    for (let i = 0; i < 40; i++) expect((await actions.getPlaybackUrl({ entryId: ENTRY })).ok, String(i)).toBe(true);
    expect(await actions.getPlaybackUrl({ entryId: ENTRY })).toEqual({ ok: false, code: "tooMany" });
    h.session = { user: { id: "22222222-0000-4000-8000-000000000002" } };
    expect((await actions.getPlaybackUrl({ entryId: ENTRY })).ok).toBe(true);
  });

  it("a failing dependency is a plain 'unavailable' that leaks nothing", async () => {
    h.throwOnDeps = true;
    const res = await actions.getPlaybackUrl({ entryId: ENTRY });
    expect(res).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(res)).not.toMatch(/SECRET|sb_secret/);
  });

  it("copes with a malformed request", async () => {
    for (const bad of [undefined, null, {}, { entryId: 5 }, { entryId: "nope" }]) expect((await actions.getPlaybackUrl(bad as never)).ok, JSON.stringify(bad)).toBe(false);
    expect(h.deps.store.presignGet).not.toHaveBeenCalled();
  });
});

describe("saveMyScore", () => {
  const input = { entryId: ENTRY, marks: "70", comments: "", final: false };
  it("needs an active judge session", async () => {
    h.session = null;
    expect(await actions.saveMyScore(input)).toEqual({ ok: false, code: "notAllowed" });
    expect(scoreDb.find).not.toHaveBeenCalled();
  });
  it("saves through the judge's own session", async () => {
    expect(await actions.saveMyScore(input)).toEqual({ ok: true, status: "draft" });
    expect(scoreDb.insert).toHaveBeenCalledOnce();
  });
  it("a final score cannot be saved again", async () => {
    scoreDb.find.mockResolvedValue({ id: "s1", status: "final" });
    expect(await actions.saveMyScore({ ...input, final: true })).toEqual({ ok: false, code: "locked" });
  });
  it("copes with a missing request", async () => {
    expect((await actions.saveMyScore(undefined as never)).ok).toBe(false);
  });
  it("limits each judge to 120 saves per 10 minutes", async () => {
    for (let i = 0; i < 120; i++) await actions.saveMyScore(input);
    expect(await actions.saveMyScore(input)).toEqual({ ok: false, code: "tooMany" });
  });
});
