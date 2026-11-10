import { beforeEach, describe, expect, it, vi } from "vitest";

// The server actions around the upload service: who the parent is, whether uploads are configured, rate limits, and that
// nothing sensitive leaks. The service itself is covered in lib/upload/service.test.ts and supabase/tests/upload-flow.test.ts.

const h = vi.hoisted(() => ({
  user: { id: "aaaaaaaa-0000-4000-8000-00000000000a" } as { id: string } | null,
  available: true,
  sessionLookups: 0,
  deps: { store: { presignPut: vi.fn(), head: vi.fn(), copy: vi.fn(), remove: vi.fn() }, db: { issue: vi.fn(), check: vi.fn(), attach: vi.fn(), reject: vi.fn() } },
  throwOnDeps: false,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => {
        h.sessionLookups++;
        return { data: { user: h.user } };
      },
    },
  }),
}));
vi.mock("@/lib/upload/server", () => ({
  uploadsAvailable: () => h.available,
  createUploadDeps: () => {
    if (h.throwOnDeps) throw new Error("SECRET-DETAIL sb_secret_leak");
    return h.deps;
  },
}));

type Actions = typeof import("./video-actions");
let actions: Actions;
const SUB = "bbbbbbbb-0000-4000-8000-0000000000b1";
const ask = (over: Record<string, unknown> = {}) => ({ submissionId: SUB, type: "video/mp4", bytes: 20 * 1024 * 1024, seconds: 45, ...over });

beforeEach(async () => {
  vi.resetModules(); // fresh rate limiters
  h.user = { id: "aaaaaaaa-0000-4000-8000-00000000000a" };
  h.available = true;
  h.sessionLookups = 0;
  h.throwOnDeps = false;
  Object.values(h.deps.db).forEach((f) => f.mockReset());
  Object.values(h.deps.store).forEach((f) => f.mockReset());
  h.deps.db.issue.mockResolvedValue({ uploadId: "cccccccc-0000-4000-8000-0000000000c1", expiresAt: "2026-11-05T10:00:00Z" });
  h.deps.store.presignPut.mockResolvedValue("https://r2.test/pending/cccccccc-0000-4000-8000-0000000000c1?sig=1");
  actions = await import("./video-actions");
});

describe("requestVideoUpload", () => {
  it("refuses a visitor who is not signed in, before touching the database or the bucket", async () => {
    h.user = null;
    expect(await actions.requestVideoUpload(ask())).toEqual({ ok: false, code: "notFound" });
    expect(h.deps.db.issue).not.toHaveBeenCalled();
    expect(h.deps.store.presignPut).not.toHaveBeenCalled();
  });

  it("stays unavailable while uploads are switched off or not configured, and does nothing else (not even a session lookup)", async () => {
    h.available = false;
    expect(await actions.requestVideoUpload(ask())).toEqual({ ok: false, code: "unavailable" });
    expect(h.sessionLookups).toBe(0);
    expect(h.deps.db.issue).not.toHaveBeenCalled();
    expect(h.deps.store.presignPut).not.toHaveBeenCalled();
  });

  it("takes the parent from the verified session, never from the request", async () => {
    const forged = { ...ask(), ownerId: "99999999-0000-4000-8000-000000000009", owner_id: "99999999-0000-4000-8000-000000000009" };
    const res = await actions.requestVideoUpload(forged);
    expect(res.ok).toBe(true);
    expect(h.deps.db.issue).toHaveBeenCalledExactlyOnceWith("aaaaaaaa-0000-4000-8000-00000000000a", SUB, "video/mp4", 20 * 1024 * 1024);
  });

  it("limits each parent to 10 authorizations per 10 minutes, and other parents are unaffected", async () => {
    for (let i = 0; i < 10; i++) expect((await actions.requestVideoUpload(ask())).ok, String(i)).toBe(true);
    expect(await actions.requestVideoUpload(ask())).toEqual({ ok: false, code: "tooMany" });
    expect(h.deps.db.issue).toHaveBeenCalledTimes(10);
    h.user = { id: "dddddddd-0000-4000-8000-0000000000d1" };
    expect((await actions.requestVideoUpload(ask())).ok).toBe(true);
  });

  it("returns only a plain failure code when a dependency throws, never its message", async () => {
    h.throwOnDeps = true;
    const res = await actions.requestVideoUpload(ask());
    expect(res).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(res)).not.toMatch(/SECRET|sb_secret/);
  });

  it("copes with a malformed request without throwing, and signs nothing", async () => {
    for (const bad of [undefined, null, {}, { submissionId: 5 }, ask({ bytes: "big" }), ask({ type: null }), ask({ seconds: "forty" })]) {
      const res = await actions.requestVideoUpload(bad as never);
      expect(res.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(h.deps.db.issue).not.toHaveBeenCalled();
    expect(h.deps.store.presignPut).not.toHaveBeenCalled();
  });

  it("returns the presigned URL only in the successful result, with no storage key field", async () => {
    const res = await actions.requestVideoUpload(ask());
    expect(res).toMatchObject({ ok: true, uploadId: "cccccccc-0000-4000-8000-0000000000c1", contentType: "video/mp4" });
    expect(Object.keys(res).sort()).toEqual(["contentType", "expiresAt", "ok", "uploadId", "url"]);
  });
});

describe("confirmVideoUpload", () => {
  it("refuses a visitor who is not signed in, and an unconfigured server", async () => {
    h.user = null;
    expect(await actions.confirmVideoUpload({ uploadId: SUB })).toEqual({ ok: false, code: "notFound" });
    h.user = { id: "aaaaaaaa-0000-4000-8000-00000000000a" };
    h.available = false;
    h.sessionLookups = 0;
    expect(await actions.confirmVideoUpload({ uploadId: SUB })).toEqual({ ok: false, code: "unavailable" });
    expect(h.sessionLookups).toBe(0);
    expect(h.deps.db.check).not.toHaveBeenCalled();
    expect(h.deps.store.head).not.toHaveBeenCalled();
  });

  it("authorizes in the database first: an unauthorized request never reaches the bucket", async () => {
    h.deps.db.check.mockRejectedValue(new Error("not_found"));
    expect(await actions.confirmVideoUpload({ uploadId: SUB })).toEqual({ ok: false, code: "notFound" });
    expect(h.deps.db.check).toHaveBeenCalledExactlyOnceWith("aaaaaaaa-0000-4000-8000-00000000000a", SUB);
    expect(h.deps.store.head).not.toHaveBeenCalled();
  });

  it("verifies the stored object for the signed-in parent only, and rate limits", async () => {
    h.deps.db.check.mockResolvedValue({ bytes: 20 * 1024 * 1024, type: "video/mp4" });
    h.deps.store.head.mockResolvedValue(null);
    expect(await actions.confirmVideoUpload({ uploadId: SUB })).toEqual({ ok: false, code: "missing" });
    for (let i = 0; i < 29; i++) await actions.confirmVideoUpload({ uploadId: SUB });
    expect(await actions.confirmVideoUpload({ uploadId: SUB })).toEqual({ ok: false, code: "tooMany" });
  });

  it("never logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await actions.requestVideoUpload(ask());
    await actions.confirmVideoUpload({ uploadId: SUB });
    h.throwOnDeps = true;
    await actions.requestVideoUpload(ask());
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
