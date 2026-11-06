import { describe, expect, it, vi } from "vitest";
import { createPlaybackDb, createPlaybackDeps, playbackAvailable, playbackConfigured, playbackEnabled } from "./server";
import { mintPlayback, PLAYBACK_TTL_SECONDS, type PlaybackDeps } from "./playback";
import type { SupabaseClient } from "@supabase/supabase-js";

const JUDGE = "11111111-0000-4000-8000-000000000001";
const ENTRY = "bbbbbbbb-0000-4000-8000-0000000000b1";
const VIDEO = "cccccccc-0000-4000-8000-0000000000c1";

function setup(over: { authorize?: () => Promise<string>; presign?: () => Promise<string> } = {}) {
  const authorize = vi.fn(over.authorize ?? (async () => VIDEO));
  const presignGet = vi.fn(over.presign ?? (async () => "https://acct.r2.test/signed?X-Amz-Signature=fake"));
  const deps: PlaybackDeps = { authorize, store: { presignGet } };
  return { authorize, presignGet, deps };
}

describe("mintPlayback", () => {
  it("authorizes in the database FIRST, then signs a link for videos/<id> that lives at most five minutes", async () => {
    const { authorize, presignGet, deps } = setup();
    const order: string[] = [];
    authorize.mockImplementation(async () => (order.push("authorize"), VIDEO));
    presignGet.mockImplementation(async () => (order.push("sign"), "https://acct.r2.test/signed"));
    const res = await mintPlayback(deps, { judgeId: JUDGE, entryId: ENTRY });
    expect(order).toEqual(["authorize", "sign"]);
    expect(authorize).toHaveBeenCalledExactlyOnceWith(JUDGE, ENTRY);
    expect(presignGet).toHaveBeenCalledExactlyOnceWith(`videos/${VIDEO}`, { expiresInSeconds: PLAYBACK_TTL_SECONDS });
    expect(PLAYBACK_TTL_SECONDS).toBeLessThanOrEqual(300);
    expect(res).toEqual({ ok: true, url: "https://acct.r2.test/signed", expiresInSeconds: 300 });
  });

  it("never reveals the object key or the video id in what it returns", async () => {
    const { deps } = setup();
    const res = await mintPlayback(deps, { judgeId: JUDGE, entryId: ENTRY });
    expect(JSON.stringify(res)).not.toContain(VIDEO);
    expect(JSON.stringify(res)).not.toContain("videos/");
  });

  it("a malformed entry id never reaches the database or the bucket", async () => {
    for (const bad of ["", "nope", "videos/x", 5, null, undefined, {}]) {
      const { authorize, presignGet, deps } = setup();
      expect(await mintPlayback(deps, { judgeId: JUDGE, entryId: bad }), String(bad)).toEqual({ ok: false, code: "invalid" });
      expect(authorize).not.toHaveBeenCalled();
      expect(presignGet).not.toHaveBeenCalled();
    }
  });

  it("an entry the database refuses (not assigned, not finalized, unknown, inactive judge) signs nothing", async () => {
    const { presignGet, deps } = setup({ authorize: async () => { throw new Error("not_found"); } });
    expect(await mintPlayback(deps, { judgeId: JUDGE, entryId: ENTRY })).toEqual({ ok: false, code: "notFound" });
    expect(presignGet).not.toHaveBeenCalled();
  });

  it("any other failure is a plain 'unavailable' that never echoes its text", async () => {
    const a = setup({ authorize: async () => { throw new Error("connection to 10.0.0.1 refused password=hunter2"); } });
    const ra = await mintPlayback(a.deps, { judgeId: JUDGE, entryId: ENTRY });
    expect(ra).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(ra)).not.toMatch(/hunter2|10\.0/);
    expect(a.presignGet).not.toHaveBeenCalled();
    const b = setup({ presign: async () => { throw new Error("R2 503 https://acct.r2.cloudflarestorage.com"); } });
    const rb = await mintPlayback(b.deps, { judgeId: JUDGE, entryId: ENTRY });
    expect(rb).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(rb)).not.toMatch(/r2|cloudflare/i);
  });
});

describe("the playback switch (RIO_PLAYBACK_ENABLED)", () => {
  const r2 = { R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", R2_BUCKET_NAME: "rio-test-videos", R2_ACCESS_KEY_ID: "a".repeat(32), R2_SECRET_ACCESS_KEY: "b".repeat(64), SUPABASE_SECRET_KEY: "sb_secret_x" };

  it("only the exact value yes turns it on; every other spelling is off", () => {
    expect(playbackEnabled({ RIO_PLAYBACK_ENABLED: "yes" })).toBe(true);
    for (const v of [undefined, "", " ", "no", "No", "YES", "Yes", " yes", "yes ", "true", "1", "on"]) expect(playbackEnabled({ RIO_PLAYBACK_ENABLED: v }), JSON.stringify(v)).toBe(false);
  });
  it("is independent of the upload and final-submission switches", () => {
    expect(playbackEnabled({ RIO_UPLOADS_ENABLED: "yes", RIO_FINALIZE_ENABLED: "yes" })).toBe(false);
  });
  it("is available only with the switch AND the configuration", () => {
    expect(playbackAvailable(r2)).toBe(false);
    expect(playbackAvailable({ ...r2, RIO_PLAYBACK_ENABLED: "no" })).toBe(false);
    expect(playbackAvailable({ ...r2, RIO_PLAYBACK_ENABLED: "yes" })).toBe(true);
    expect(playbackAvailable({ RIO_PLAYBACK_ENABLED: "yes" })).toBe(false);
    expect(playbackAvailable({ ...r2, RIO_PLAYBACK_ENABLED: "yes", SUPABASE_SECRET_KEY: "" })).toBe(false);
    expect(playbackConfigured(r2)).toBe(true);
  });
  it("createPlaybackDeps refuses to build anything while the switch is off", () => {
    for (const [k, v] of Object.entries(r2)) vi.stubEnv(k, v);
    for (const value of ["no", "", "YES"]) {
      vi.stubEnv("RIO_PLAYBACK_ENABLED", value);
      expect(() => createPlaybackDeps(), value).toThrow("switched off");
    }
    vi.unstubAllEnvs();
  });
});

describe("createPlaybackDb", () => {
  const rpc = vi.fn();
  const db = createPlaybackDb({ rpc } as unknown as SupabaseClient);
  it("calls only authorize_playback with the judge and entry, and maps 'not_found'", async () => {
    rpc.mockResolvedValueOnce({ data: VIDEO, error: null });
    expect(await db.authorize(JUDGE, ENTRY)).toBe(VIDEO);
    expect(rpc).toHaveBeenLastCalledWith("authorize_playback", { p_judge: JUDGE, p_submission: ENTRY });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "not_found" } });
    await expect(db.authorize(JUDGE, ENTRY)).rejects.toThrow("not_found");
    rpc.mockResolvedValueOnce({ data: null, error: { message: "deadlock detected password=hunter2" } });
    await expect(db.authorize(JUDGE, ENTRY)).rejects.toThrow(/^database$/);
    rpc.mockResolvedValueOnce({ data: 42, error: null });
    await expect(db.authorize(JUDGE, ENTRY)).rejects.toThrow("not_found");
  });
});
