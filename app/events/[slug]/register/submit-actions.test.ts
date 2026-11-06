import { beforeEach, describe, expect, it, vi } from "vitest";

// The server action around final submission: the switch, who the parent is, which competition, rate limits, and that nothing
// sensitive leaks. The service is covered in lib/submit/service.test.ts and supabase/tests/finalize-flow.test.ts.

const h = vi.hoisted(() => ({
  user: { id: "aaaaaaaa-0000-4000-8000-00000000000a" } as { id: string } | null,
  available: true,
  sessionLookups: 0,
  throwOnDeps: false,
  deps: { store: { head: vi.fn() }, db: { check: vi.fn(), finalize: vi.fn() }, consentKnown: () => true },
  afters: [] as (() => unknown)[],
  queue: vi.fn(async (id: string) => void id),
}));

// after() runs its callback once the response is sent; here the tests run the callbacks by hand so they can see WHEN and WHETHER it is queued.
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void h.afters.push(fn) }));
vi.mock("@/lib/email/server", () => ({ queueConfirmation: (id: string) => h.queue(id) }));

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
vi.mock("@/lib/submit/server", () => ({
  finalizeAvailable: () => h.available,
  createFinalizeDeps: () => {
    if (h.throwOnDeps) throw new Error("SECRET-DETAIL sb_secret_leak");
    return h.deps;
  },
}));

type Actions = typeof import("./submit-actions");
let actions: Actions;
const SUB = "bbbbbbbb-0000-4000-8000-0000000000b1";
const ask = (over: Record<string, unknown> = {}) => ({ submissionId: SUB, slug: "kutti-pesalar", ...over });
const record = { uploadId: "cccccccc-0000-4000-8000-0000000000c1", bytes: 100, type: "video/mp4", etag: '"e"', eventId: 4, consentVersion: "v0-provisional", already: false };

beforeEach(async () => {
  vi.resetModules(); // fresh rate limiter
  h.user = { id: "aaaaaaaa-0000-4000-8000-00000000000a" };
  h.available = true;
  h.sessionLookups = 0;
  h.throwOnDeps = false;
  h.afters.length = 0;
  h.queue.mockReset().mockResolvedValue(undefined);
  Object.values(h.deps.db).forEach((f) => f.mockReset());
  h.deps.store.head.mockReset().mockResolvedValue({ bytes: 100, contentType: "video/mp4", etag: '"e"' });
  h.deps.db.check.mockResolvedValue(record);
  h.deps.db.finalize.mockResolvedValue("finalized");
  actions = await import("./submit-actions");
});

describe("submitEntry", () => {
  it("with final submission switched off, nothing else runs: not even a session lookup", async () => {
    h.available = false;
    expect(await actions.submitEntry(ask())).toEqual({ ok: false, code: "unavailable" });
    expect(h.sessionLookups).toBe(0);
    expect(h.deps.db.check).not.toHaveBeenCalled();
    expect(h.deps.store.head).not.toHaveBeenCalled();
  });

  it("refuses a visitor whose session has expired or who is not signed in, before the database or the bucket", async () => {
    h.user = null;
    expect(await actions.submitEntry(ask())).toEqual({ ok: false, code: "notFound" });
    expect(h.deps.db.check).not.toHaveBeenCalled();
    expect(h.deps.store.head).not.toHaveBeenCalled();
    expect(h.deps.db.finalize).not.toHaveBeenCalled();
  });

  it("takes the parent from the verified session, never from the request", async () => {
    const res = await actions.submitEntry({ ...ask(), ownerId: "99999999-0000-4000-8000-000000000009", owner_id: "99999999-0000-4000-8000-000000000009" } as never);
    expect(res).toEqual({ ok: true, already: false });
    expect(h.deps.db.check).toHaveBeenCalledExactlyOnceWith("aaaaaaaa-0000-4000-8000-00000000000a", SUB);
    expect(h.deps.db.finalize.mock.calls[0]![0]).toBe("aaaaaaaa-0000-4000-8000-00000000000a");
  });

  it("uses the competition of the page's slug, and refuses an unknown or malformed slug with no database call", async () => {
    expect((await actions.submitEntry(ask({ slug: "tamilil-sollu" }))).ok).toBe(false); // the entry is in competition 4: a different slug does not match
    expect(h.deps.store.head).not.toHaveBeenCalled();
    for (const slug of ["nope", "", 5, null, undefined, "../x"]) {
      h.deps.db.check.mockClear();
      expect(await actions.submitEntry(ask({ slug }) as never), String(slug)).toEqual({ ok: false, code: "notFound" });
      expect(h.deps.db.check).not.toHaveBeenCalled();
    }
  });

  it("is idempotent: submitting an entry that is already final succeeds without touching the bucket", async () => {
    h.deps.db.check.mockResolvedValue({ ...record, already: true });
    expect(await actions.submitEntry(ask())).toEqual({ ok: true, already: true });
    expect(h.deps.store.head).not.toHaveBeenCalled();
    expect(h.deps.db.finalize).not.toHaveBeenCalled();
  });

  it("limits each parent to 5 attempts per 10 minutes, and other parents are unaffected", async () => {
    for (let i = 0; i < 5; i++) expect((await actions.submitEntry(ask())).ok, String(i)).toBe(true);
    expect(await actions.submitEntry(ask())).toEqual({ ok: false, code: "tooMany" });
    h.user = { id: "dddddddd-0000-4000-8000-0000000000d1" };
    expect((await actions.submitEntry(ask())).ok).toBe(true);
  });

  it("returns only a plain failure code when a dependency throws, never its message", async () => {
    h.throwOnDeps = true;
    const res = await actions.submitEntry(ask());
    expect(res).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(res)).not.toMatch(/SECRET|sb_secret/);
  });

  it("copes with a malformed request without throwing", async () => {
    for (const bad of [undefined, null, {}, { slug: "kutti-pesalar" }, ask({ submissionId: 5 }), ask({ submissionId: "not-a-uuid" })]) {
      const res = await actions.submitEntry(bad as never);
      expect(res.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(h.deps.db.finalize).not.toHaveBeenCalled();
  });

  it("queues the confirmation e-mail AFTER the response, once, only for the request that made the entry final", async () => {
    const res = await actions.submitEntry(ask());
    expect(res).toEqual({ ok: true, already: false });
    expect(h.queue).not.toHaveBeenCalled(); // nothing has run yet: it is deferred until after the response
    expect(h.afters).toHaveLength(1);
    await h.afters[0]!();
    expect(h.queue).toHaveBeenCalledExactlyOnceWith(SUB);
  });

  it("does not queue an e-mail for a repeat request, a refusal or a failure", async () => {
    h.deps.db.check.mockResolvedValue({ ...record, already: true });
    await actions.submitEntry(ask());
    h.available = false;
    await actions.submitEntry(ask());
    h.available = true;
    h.user = null;
    await actions.submitEntry(ask());
    expect(h.afters).toHaveLength(0);
    expect(h.queue).not.toHaveBeenCalled();
  });

  it("an e-mail failure cannot change the result: the entry stays submitted", async () => {
    h.queue.mockRejectedValue(new Error("provider down"));
    const res = await actions.submitEntry(ask());
    expect(res).toEqual({ ok: true, already: false });
    await expect(Promise.resolve(h.afters[0]!()).catch(() => "swallowed")).resolves.toBeDefined();
  });

  it("never logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await actions.submitEntry(ask());
    h.throwOnDeps = true;
    await actions.submitEntry(ask());
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
