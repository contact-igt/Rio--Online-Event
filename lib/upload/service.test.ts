import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ObjectHead, ObjectStore } from "@/lib/storage/object-store";
import { codeFromDbError, finishUpload, startUpload, type UploadDb } from "./service";

// Only a video whose stored object was checked may be attached, and nobody is served before the database authorizes them.
// These tests use spies, so they prove the ORDER and the CONDITIONS: R2 is never contacted unless the database check passed,
// and attach is never called unless HeadObject, the declaration match and the conditional copy all passed.

const OWNER = "aaaaaaaa-0000-4000-8000-00000000000a";
const UPLOAD = "cccccccc-0000-4000-8000-0000000000c1";
const MB = 1024 * 1024;
const good: ObjectHead = { bytes: 20 * MB, contentType: "video/mp4", etag: '"e1"' };

function setup(head: ObjectHead | null | Error = good) {
  const store = {
    presignPut: vi.fn(async () => "https://r2.test/pending/x?sig=1"),
    head: vi.fn(async () => {
      if (head instanceof Error) throw head;
      return head;
    }),
    copy: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  } satisfies ObjectStore;
  const db = {
    issue: vi.fn(async () => ({ uploadId: UPLOAD, expiresAt: "2026-11-05T10:00:00Z" })),
    check: vi.fn(async () => ({ bytes: 20 * MB, type: "video/mp4" })),
    attach: vi.fn(async () => ({ replaced: null as string | null })),
    reject: vi.fn(async () => undefined),
  } satisfies UploadDb;
  return { store, db, deps: { store, db } };
}
const finish = (deps: ReturnType<typeof setup>["deps"], uploadId: unknown = UPLOAD) => finishUpload(deps, { ownerId: OWNER, uploadId });
const noR2 = (store: ReturnType<typeof setup>["store"]) => {
  expect(store.head).not.toHaveBeenCalled();
  expect(store.copy).not.toHaveBeenCalled();
  expect(store.remove).not.toHaveBeenCalled();
  expect(store.presignPut).not.toHaveBeenCalled();
};

describe("finishUpload authorizes before R2 is contacted", () => {
  it("runs check, then head, then the conditional copy, then attach, in that order", async () => {
    const { store, db, deps } = setup();
    const order: string[] = [];
    db.check.mockImplementation(async () => (order.push("check"), { bytes: 20 * MB, type: "video/mp4" }));
    store.head.mockImplementation(async () => (order.push("head"), good));
    store.copy.mockImplementation(async () => void order.push("copy"));
    db.attach.mockImplementation(async () => (order.push("attach"), { replaced: null }));
    expect(await finish(deps)).toEqual({ ok: true, replaced: false });
    expect(order).toEqual(["check", "head", "copy", "attach"]);
    expect(db.check).toHaveBeenCalledExactlyOnceWith(OWNER, UPLOAD);
    expect(store.head).toHaveBeenCalledWith(`pending/${UPLOAD}`);
    expect(store.copy).toHaveBeenCalledWith(`pending/${UPLOAD}`, `videos/${UPLOAD}`, '"e1"');
    expect(db.attach).toHaveBeenCalledExactlyOnceWith(OWNER, UPLOAD, 20 * MB, "video/mp4", '"e1"');
  });

  it("an unauthorized parent (not the owner, or no such upload) is turned away with NO request to R2 and no database change", async () => {
    const { store, db, deps } = setup();
    db.check.mockRejectedValue(new Error("not_found"));
    expect(await finish(deps)).toEqual({ ok: false, code: "notFound" });
    noR2(store);
    expect(db.attach).not.toHaveBeenCalled();
    expect(db.reject).not.toHaveBeenCalled(); // someone else's authorization is never touched
  });

  it("an invalid upload id never reaches the database or R2", async () => {
    for (const bad of ["", "not-a-uuid", "pending/x", "../x", 5, null, undefined, {}, [UPLOAD]]) {
      const { store, db, deps } = setup();
      expect(await finishUpload(deps, { ownerId: OWNER, uploadId: bad }), String(bad)).toEqual({ ok: false, code: "invalid" });
      expect(db.check).not.toHaveBeenCalled();
      noR2(store);
    }
  });

  it("an expired authorization is turned away with no request to R2", async () => {
    const { store, db, deps } = setup();
    db.check.mockRejectedValue(new Error("upload_expired"));
    expect(await finish(deps)).toEqual({ ok: false, code: "expired" });
    noR2(store);
    expect(db.attach).not.toHaveBeenCalled();
  });

  it("a reused, superseded or already-finished authorization is rejected with no request to R2", async () => {
    const { store, db, deps } = setup();
    db.check.mockRejectedValue(new Error("upload_not_current"));
    expect(await finish(deps)).toEqual({ ok: false, code: "notCurrent" });
    noR2(store);
    expect(db.attach).not.toHaveBeenCalled();
  });

  it("a closed window or a locked entry stops it before R2; any other database failure is plain 'unavailable'", async () => {
    for (const [message, code] of [["submissions_closed", "closed"], ["submission_locked", "locked"], ["connection refused password=hunter2", "unavailable"]] as const) {
      const { store, db, deps } = setup();
      db.check.mockRejectedValue(new Error(message));
      expect(await finish(deps), message).toEqual({ ok: false, code });
      noR2(store);
    }
  });
});

describe("finishUpload attaches only a verified object", () => {
  it("never attaches when nothing was stored (and does not reject: the parent just starts again)", async () => {
    const { db, deps, store } = setup(null);
    expect(await finish(deps)).toEqual({ ok: false, code: "missing" });
    expect(db.attach).not.toHaveBeenCalled();
    expect(store.copy).not.toHaveBeenCalled();
    expect(db.reject).not.toHaveBeenCalled();
  });

  it("never attaches an object without an ETag, with no type, with zero bytes or over 100 MB", async () => {
    for (const [head, code] of [
      [{ ...good, etag: null }, "missing"],
      [{ ...good, contentType: null }, "mismatch"],
      [{ ...good, bytes: 0 }, "mismatch"],
      [{ ...good, bytes: 100 * MB + 1 }, "tooBig"],
    ] as const) {
      const { db, deps, store } = setup(head);
      expect(await finish(deps), code).toEqual({ ok: false, code });
      expect(db.attach, code).not.toHaveBeenCalled();
      expect(store.copy, code).not.toHaveBeenCalled();
    }
  });

  it("compares the stored object with what the authorization declared, BEFORE copying", async () => {
    for (const head of [{ ...good, bytes: 19 * MB }, { ...good, bytes: 21 * MB }, { ...good, contentType: "video/webm" }]) {
      const { db, deps, store } = setup(head);
      expect(await finish(deps)).toEqual({ ok: false, code: "mismatch" });
      expect(store.copy).not.toHaveBeenCalled();
      expect(db.attach).not.toHaveBeenCalled();
      expect(db.reject).toHaveBeenCalledWith(OWNER, UPLOAD, "rejected");
      expect(store.remove).toHaveBeenCalledWith(`pending/${UPLOAD}`);
    }
  });

  it("deletes a too-big object and kills its authorization", async () => {
    const { db, deps, store } = setup({ ...good, bytes: 200 * MB });
    await finish(deps);
    expect(db.reject).toHaveBeenCalledWith(OWNER, UPLOAD, "rejected");
    expect(store.remove).toHaveBeenCalledWith(`pending/${UPLOAD}`);
    expect(store.remove).toHaveBeenCalledWith(`videos/${UPLOAD}`);
  });

  it("an R2 error while checking is 'unavailable': nothing is attached, copied, rejected or deleted", async () => {
    const { db, deps, store } = setup(new Error("R2 503"));
    expect(await finish(deps)).toEqual({ ok: false, code: "unavailable" });
    expect(db.attach).not.toHaveBeenCalled();
    expect(db.reject).not.toHaveBeenCalled();
    expect(store.copy).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled(); // the parent can simply try the confirmation again
  });

  it("a failed or conditional copy attaches nothing and cleans up", async () => {
    const { db, deps, store } = setup();
    store.copy.mockRejectedValue(new Error("PreconditionFailed"));
    expect(await finish(deps)).toEqual({ ok: false, code: "mismatch" });
    expect(db.attach).not.toHaveBeenCalled();
    expect(db.reject).toHaveBeenCalledWith(OWNER, UPLOAD, "rejected");
  });

  it("when the database refuses the final attach, the copied object and the authorization are cleaned up (except not-found and not-current)", async () => {
    const closed = setup();
    closed.db.attach.mockRejectedValue(new Error("submissions_closed"));
    expect(await finish(closed.deps)).toEqual({ ok: false, code: "closed" });
    expect(closed.db.reject).toHaveBeenCalledWith(OWNER, UPLOAD, "rejected");
    expect(closed.store.remove).toHaveBeenCalledWith(`videos/${UPLOAD}`);

    for (const message of ["not_found", "upload_not_current"]) {
      const other = setup();
      other.db.attach.mockRejectedValue(new Error(message));
      await finish(other.deps);
      expect(other.db.reject, message).not.toHaveBeenCalled(); // someone else's or an already-finished authorization is left alone
    }
  });

  it("authorization is checked again at attach: a change between the first check and the attach stops the video being attached", async () => {
    const { db, deps, store } = setup();
    db.attach.mockRejectedValue(new Error("upload_not_current")); // e.g. superseded by a newer authorization in the meantime
    expect(await finish(deps)).toEqual({ ok: false, code: "notCurrent" });
    expect(db.check).toHaveBeenCalledTimes(1);
    expect(db.attach).toHaveBeenCalledTimes(1); // the database, not this code, has the last word
    expect(store.copy).toHaveBeenCalledTimes(1);
  });

  it("a failing cleanup call never turns a refusal into a crash, and the pending copy being left behind is not an error", async () => {
    const { db, deps, store } = setup();
    db.attach.mockResolvedValue({ replaced: UPLOAD });
    store.remove.mockRejectedValue(new Error("delete failed"));
    expect(await finish(deps)).toEqual({ ok: true, replaced: true });
    const refused = setup({ ...good, bytes: 200 * MB });
    refused.store.remove.mockRejectedValue(new Error("delete failed"));
    refused.db.reject.mockRejectedValue(new Error("db down"));
    expect(await finish(refused.deps)).toEqual({ ok: false, code: "tooBig" });
  });
});

describe("what the server verifies is metadata, NOT media (documented so nobody mistakes it for media validation)", () => {
  it("accepts ANY bytes whose size and type header match the declaration: there is no inspection of the container, codec or duration", async () => {
    const { db, deps, store } = setup({ bytes: 20 * MB, contentType: "video/mp4", etag: '"not-checked-for-content"' });
    expect(await finish(deps)).toEqual({ ok: true, replaced: false });
    expect(store.head).toHaveBeenCalledTimes(1); // the only thing read about the object is its metadata
    expect(db.attach).toHaveBeenCalledTimes(1);
  });

  it("the upload code contains no media probe and never reads the object's bytes", () => {
    for (const file of ["lib/upload/service.ts", "lib/upload/server.ts"]) {
      const code = readFileSync(join(process.cwd(), file), "utf8").replace(/\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/ffprobe|mediainfo|ffmpeg|GetObjectCommand|createReadStream|readRange|presignGet/i);
    }
    // the bucket client may read ranges since M4B (header inspection at final submission), but it runs no external media tool
    const store = readFileSync(join(process.cwd(), "lib/storage/object-store.ts"), "utf8").replace(/\/\/.*$/gm, "");
    expect(store).not.toMatch(/ffprobe|mediainfo|ffmpeg|createReadStream/i);
  });
});

describe("startUpload", () => {
  const ask = (meta: unknown) => ({ ownerId: OWNER, submissionId: "bbbbbbbb-0000-4000-8000-0000000000b1", meta });

  it("signs a 15-minute URL for pending/<id> bound to the declared type, and returns no object key", async () => {
    const { store, deps } = setup();
    const res = await startUpload(deps, ask({ type: "video/mp4", bytes: 20 * MB, seconds: 45 }));
    expect(res).toMatchObject({ ok: true, uploadId: UPLOAD, contentType: "video/mp4" });
    expect(store.presignPut).toHaveBeenCalledExactlyOnceWith(`pending/${UPLOAD}`, { contentType: "video/mp4", expiresInSeconds: 900 });
    expect(JSON.stringify(res)).not.toContain("videos/");
  });

  it("asks the database before signing anything, and signs nothing when the database refuses", async () => {
    const { store, db, deps } = setup();
    db.issue.mockRejectedValue(new Error("not_found"));
    expect(await startUpload(deps, ask({ type: "video/mp4", bytes: 20 * MB, seconds: 45 }))).toEqual({ ok: false, code: "notFound" });
    expect(store.presignPut).not.toHaveBeenCalled();
  });

  it("refuses bad declarations before the database is even asked", async () => {
    const { db, deps } = setup();
    for (const [meta, code] of [
      [{ type: "video/avi", bytes: 20 * MB, seconds: 45 }, "type"],
      [{ type: "video/mp4", bytes: 101 * MB, seconds: 45 }, "tooBig"],
      [{ type: "video/mp4", bytes: 50, seconds: 45 }, "tooSmall"],
      [{ type: "video/mp4", bytes: 20 * MB, seconds: 29 }, "tooShort"],
      [{ type: "video/mp4", bytes: 20 * MB, seconds: 91 }, "tooLong"],
      [{ type: "video/mp4", bytes: 20 * MB, seconds: null }, "unreadable"],
      [{ type: "video/mp4", bytes: 1.5, seconds: 45 }, "invalid"],
      [null, "invalid"],
    ] as const) {
      expect(await startUpload(deps, ask(meta)), code).toEqual({ ok: false, code });
    }
    expect(db.issue).not.toHaveBeenCalled();
  });

  it("abandons the authorization if signing fails", async () => {
    const { store, db, deps } = setup();
    store.presignPut.mockRejectedValue(new Error("no credentials"));
    expect(await startUpload(deps, ask({ type: "video/mp4", bytes: 20 * MB, seconds: 45 }))).toEqual({ ok: false, code: "unavailable" });
    expect(db.reject).toHaveBeenCalledWith(OWNER, UPLOAD, "abandoned");
  });
});

describe("codeFromDbError", () => {
  it("maps database messages to codes and anything unknown to 'unavailable', never echoing the message", () => {
    expect(codeFromDbError({ message: "ERROR: not_found" })).toBe("notFound");
    expect(codeFromDbError({ message: "submissions_closed" })).toBe("closed");
    expect(codeFromDbError({ message: "submission_locked" })).toBe("locked");
    expect(codeFromDbError({ message: "too_many_uploads" })).toBe("tooMany");
    expect(codeFromDbError({ message: "upload_not_current" })).toBe("notCurrent");
    expect(codeFromDbError({ message: "upload_expired" })).toBe("expired");
    expect(codeFromDbError({ message: "size_mismatch" })).toBe("mismatch");
    expect(codeFromDbError({ message: "type_mismatch" })).toBe("mismatch");
    expect(codeFromDbError({ message: "invalid_video" })).toBe("invalid");
    expect(codeFromDbError({ message: "connection to 10.0.0.1 refused password=hunter2" })).toBe("unavailable");
    expect(codeFromDbError(null)).toBe("unavailable");
  });
});
