import { describe, expect, it, vi } from "vitest";
import type { ObjectHead } from "@/lib/storage/object-store";
import type { Inspection } from "./inspect";
import { finalizeCodeFromDbError, finalizeEntry, type FinalizeDb, type FinalizeDeps, type FinalizeRecord } from "./service";

// Final submission with a MOCKED bucket and a MOCKED database: these tests prove the ORDER and the CONDITIONS. The real SQL is
// covered in supabase/tests/finalize.test.ts and the two together in supabase/tests/finalize-flow.test.ts.

const OWNER = "aaaaaaaa-0000-4000-8000-00000000000a";
const SUB = "bbbbbbbb-0000-4000-8000-0000000000b1";
const UPLOAD = "cccccccc-0000-4000-8000-0000000000c1";
const MB = 1024 * 1024;
const record: FinalizeRecord = { uploadId: UPLOAD, bytes: 20 * MB, type: "video/mp4", etag: '"e1"', eventId: 4, consentVersion: "v0-provisional", already: false };
const head: ObjectHead = { bytes: 20 * MB, contentType: "video/mp4", etag: '"e1"' };

function setup(over: { record?: Partial<FinalizeRecord>; head?: ObjectHead | null | Error; consentKnown?: boolean } = {}) {
  const store = {
    head: vi.fn(async () => {
      if (over.head instanceof Error) throw over.head;
      return over.head === undefined ? head : over.head;
    }),
  };
  const db = {
    check: vi.fn(async () => ({ ...record, ...over.record })),
    finalize: vi.fn(async () => "finalized" as "finalized" | "already_finalized"),
  } satisfies FinalizeDb;
  const deps: FinalizeDeps = { store, db, consentKnown: () => over.consentKnown ?? true };
  return { store, db, deps };
}
const run = (deps: FinalizeDeps, over: { submissionId?: unknown; eventId?: number } = {}) =>
  finalizeEntry(deps, { ownerId: OWNER, submissionId: "submissionId" in over ? over.submissionId : SUB, eventId: over.eventId ?? 4 });
const noR2 = (store: ReturnType<typeof setup>["store"]) => expect(store.head).not.toHaveBeenCalled();

describe("a valid final submission", () => {
  it("checks the database, then the bucket, then makes the one transition, passing the bucket's CURRENT values", async () => {
    const { store, db, deps } = setup();
    const order: string[] = [];
    db.check.mockImplementation(async () => (order.push("check"), record));
    store.head.mockImplementation(async () => (order.push("head"), head));
    db.finalize.mockImplementation(async () => (order.push("finalize"), "finalized"));
    expect(await run(deps)).toEqual({ ok: true, already: false });
    expect(order).toEqual(["check", "head", "finalize"]);
    expect(db.check).toHaveBeenCalledExactlyOnceWith(OWNER, SUB);
    expect(store.head).toHaveBeenCalledExactlyOnceWith(`videos/${UPLOAD}`); // the key comes from the database record, never from the request
    expect(db.finalize).toHaveBeenCalledExactlyOnceWith(OWNER, SUB, UPLOAD, 20 * MB, "video/mp4", '"e1"');
  });

  it("returns no object key, ETag, URL or id in its result", async () => {
    const { deps } = setup();
    expect(JSON.stringify(await run(deps))).toBe('{"ok":true,"already":false}');
  });
});

describe("it turns the wrong requests away BEFORE the bucket is contacted", () => {
  it("a missing video, an unverified video, another parent's entry, a closed window and a wrong status each end at the database check", async () => {
    for (const [message, code] of [
      ["video_missing", "noVideo"],
      ["video_not_verified", "videoNotVerified"],
      ["not_found", "notFound"],
      ["submissions_closed", "closed"],
      ["invalid_status_transition", "status"],
      ["submission_locked", "locked"],
      ["consent_missing", "consent"],
    ] as const) {
      const { store, db, deps } = setup();
      db.check.mockRejectedValue(new Error(message));
      expect(await run(deps), message).toEqual({ ok: false, code });
      noR2(store);
      expect(db.finalize).not.toHaveBeenCalled();
    }
  });

  it("a malformed submission id never reaches the database or the bucket", async () => {
    for (const bad of ["", "nope", "videos/x", 5, null, undefined, {}]) {
      const { store, db, deps } = setup();
      expect(await run(deps, { submissionId: bad }), String(bad)).toEqual({ ok: false, code: "invalid" });
      expect(db.check).not.toHaveBeenCalled();
      noR2(store);
    }
  });

  it("an entry from a different competition than the page's is refused as not found, with no bucket request", async () => {
    const { store, db, deps } = setup();
    expect(await run(deps, { eventId: 5 })).toEqual({ ok: false, code: "notFound" });
    noR2(store);
    expect(db.finalize).not.toHaveBeenCalled();
  });

  it("a consent record the app does not recognise is refused with no bucket request", async () => {
    const { store, db, deps } = setup({ consentKnown: false });
    expect(await run(deps)).toEqual({ ok: false, code: "consent" });
    noR2(store);
    expect(db.finalize).not.toHaveBeenCalled();
  });

  it("an unknown database failure is plain 'unavailable' and never echoes its text", async () => {
    const { store, db, deps } = setup();
    db.check.mockRejectedValue(new Error("connection to 10.0.0.1 refused password=hunter2"));
    const res = await run(deps);
    expect(res).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(res)).not.toMatch(/hunter2|10\.0/);
    noR2(store);
  });
});

describe("the bucket object must still be the one that was verified", () => {
  it("a missing object is refused and nothing is changed", async () => {
    const { db, deps } = setup({ head: null });
    expect(await run(deps)).toEqual({ ok: false, code: "videoMissing" });
    expect(db.finalize).not.toHaveBeenCalled();
  });

  it("a different size, type or ETag is refused and nothing is changed", async () => {
    for (const changed of [{ ...head, bytes: 21 * MB }, { ...head, bytes: 0 }, { ...head, contentType: "video/webm" }, { ...head, contentType: null }, { ...head, etag: '"e2"' }]) {
      const { db, deps } = setup({ head: changed });
      expect(await run(deps), JSON.stringify(changed)).toEqual({ ok: false, code: "videoChanged" });
      expect(db.finalize).not.toHaveBeenCalled();
    }
  });

  it("an object without an ETag is treated as missing", async () => {
    const { db, deps } = setup({ head: { ...head, etag: null } });
    expect(await run(deps)).toEqual({ ok: false, code: "videoMissing" });
    expect(db.finalize).not.toHaveBeenCalled();
  });

  it("a bucket failure while checking is 'unavailable': nothing is changed and the parent can try again", async () => {
    const { db, deps } = setup({ head: new Error("R2 503 https://acct.r2.cloudflarestorage.com/secret-bucket") });
    const res = await run(deps);
    expect(res).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(res)).not.toMatch(/r2|secret-bucket/i);
    expect(db.finalize).not.toHaveBeenCalled();
  });
});

describe("the database transition", () => {
  it("maps the transition's own refusals: video changed, not verified, window closed, duplicate child, locked", async () => {
    for (const [message, code] of [
      ["video_changed", "videoChanged"],
      ["video_not_verified", "videoNotVerified"],
      ["submissions_closed", "closed"],
      ["duplicate_entry", "duplicate"],
      ["submission_locked", "locked"],
      ["not_found", "notFound"],
    ] as const) {
      const { db, deps } = setup();
      db.finalize.mockRejectedValue(new Error(message));
      expect(await run(deps), message).toEqual({ ok: false, code });
    }
  });

  it("a database failure at the transition is 'unavailable' without leaking its text", async () => {
    const { db, deps } = setup();
    db.finalize.mockRejectedValue(new Error("deadlock detected on relation submissions password=hunter2"));
    const res = await run(deps);
    expect(res).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(res)).not.toMatch(/hunter2|deadlock/);
  });

  it("is idempotent: an entry that is already final is answered, with no bucket request and no second transition", async () => {
    const { store, db, deps } = setup({ record: { already: true } });
    expect(await run(deps)).toEqual({ ok: true, already: true });
    noR2(store);
    expect(db.finalize).not.toHaveBeenCalled();
  });

  it("when two requests race, the loser is told 'already' by the database and still succeeds", async () => {
    const { db, deps } = setup();
    db.finalize.mockResolvedValueOnce("finalized").mockResolvedValueOnce("already_finalized");
    const [a, b] = await Promise.all([run(deps), run(deps)]);
    expect([a, b]).toEqual([{ ok: true, already: false }, { ok: true, already: true }]);
  });
});

describe("finalizeCodeFromDbError", () => {
  it("maps database messages to codes, and anything unknown to 'unavailable'", () => {
    expect(finalizeCodeFromDbError({ message: "ERROR: not_found" })).toBe("notFound");
    expect(finalizeCodeFromDbError({ message: "invalid_status_transition" })).toBe("status");
    expect(finalizeCodeFromDbError({ message: "submissions_closed" })).toBe("closed");
    expect(finalizeCodeFromDbError({ message: "submission_locked" })).toBe("locked");
    expect(finalizeCodeFromDbError({ message: "video_missing" })).toBe("noVideo");
    expect(finalizeCodeFromDbError({ message: "video_not_verified" })).toBe("videoNotVerified");
    expect(finalizeCodeFromDbError({ message: "video_changed" })).toBe("videoChanged");
    expect(finalizeCodeFromDbError({ message: "consent_missing" })).toBe("consent");
    expect(finalizeCodeFromDbError({ message: "duplicate_entry" })).toBe("duplicate");
    expect(finalizeCodeFromDbError({ message: "something else entirely" })).toBe("unavailable");
    expect(finalizeCodeFromDbError(null)).toBe("unavailable");
  });
});

describe("the stored file must look like a video (bounded header inspection)", () => {
  const withInspect = (result: Inspection | Error) => {
    const base = setup();
    const inspect = vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    return { ...base, inspect, deps: { ...base.deps, inspect } as FinalizeDeps };
  };

  it("runs after the bucket comparison and before the transition, on the verified object and its bucket-current type and size", async () => {
    const { db, deps, inspect } = withInspect({ ok: true, container: "mp4", durationSeconds: 45 });
    expect(await run(deps)).toEqual({ ok: true, already: false });
    expect(inspect).toHaveBeenCalledExactlyOnceWith(`videos/${UPLOAD}`, "video/mp4", 20 * MB);
    expect(db.finalize).toHaveBeenCalledOnce();
  });

  it("a WebM with no declared duration is accepted (its length is simply not verified here)", async () => {
    const { deps } = withInspect({ ok: true, container: "webm", durationSeconds: null });
    expect(await run(deps)).toEqual({ ok: true, already: false });
  });

  it("not a video, a wrong container or an unreadable header is refused and nothing changes", async () => {
    for (const reason of ["notVideo", "typeMismatch", "unreadable"] as const) {
      const { db, deps } = withInspect({ ok: false, reason });
      expect(await run(deps), reason).toEqual({ ok: false, code: "videoInvalid" });
      expect(db.finalize).not.toHaveBeenCalled();
    }
  });

  it("a declared duration outside the range is refused with its own message", async () => {
    for (const reason of ["tooShort", "tooLong"] as const) {
      const { db, deps } = withInspect({ ok: false, reason });
      expect(await run(deps), reason).toEqual({ ok: false, code: "videoDuration" });
      expect(db.finalize).not.toHaveBeenCalled();
    }
  });

  it("a bucket failure while inspecting is 'unavailable', not a verdict on the video", async () => {
    const { db, deps } = withInspect(new Error("R2 503 https://acct.r2.cloudflarestorage.com"));
    const res = await run(deps);
    expect(res).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(res)).not.toMatch(/r2|cloudflare/i);
    expect(db.finalize).not.toHaveBeenCalled();
  });

  it("is not reached when the bucket object already differs from the verified record", async () => {
    const { deps, inspect } = withInspect({ ok: true, container: "mp4", durationSeconds: 45 });
    deps.store.head = vi.fn(async () => ({ ...head, etag: '"other"' }));
    expect(await run(deps)).toEqual({ ok: false, code: "videoChanged" });
    expect(inspect).not.toHaveBeenCalled();
  });
});
