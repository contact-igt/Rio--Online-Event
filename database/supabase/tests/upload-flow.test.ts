import { describe, expect, it } from "vitest";
import type { ObjectStore } from "../../../website/lib/storage/object-store";
import { cleanupUploads } from "../../../website/lib/upload/cleanup";
import { finishUpload, startUpload, type UploadDb } from "../../../website/lib/upload/service";
import { actAs, ids, insertDraft, q, setupDb } from "./helpers";

// The M4A upload flow end to end with the REAL service code and the REAL database functions (PGlite), and a fake R2
// that behaves like a private bucket: a presigned URL is a bearer credential for one key and one Content-Type until it
// expires, a PUT may overwrite the same key, and a conditional copy fails if the source changed. This proves our logic.
// Real R2 is UNVERIFIED until it is configured and authorized.

const db = setupDb();
const MB = 1024 * 1024;

type Obj = { bytes: number; type: string; etag: string };
class FakeR2 {
  objects = new Map<string, Obj>();
  urls = new Map<string, { key: string; type: string; expiresAt: number }>();
  private n = 0;
  now = Date.now();
  /** How many times the server asked the bucket for something (the browser's own PUT is not counted). */
  calls = { presign: 0, head: 0, copy: 0, remove: 0 };
  store: ObjectStore = {
    presignPut: async (key, { contentType, expiresInSeconds }) => {
      this.calls.presign++;
      const url = `https://r2.test/${key}?sig=${++this.n}`;
      this.urls.set(url, { key, type: contentType, expiresAt: this.now + expiresInSeconds * 1000 });
      return url;
    },
    head: async (key) => {
      this.calls.head++;
      const o = this.objects.get(key);
      return o ? { bytes: o.bytes, contentType: o.type, etag: o.etag } : null;
    },
    copy: async (from, to, ifMatch) => {
      this.calls.copy++;
      const o = this.objects.get(from);
      if (!o || o.etag !== ifMatch) throw new Error("PreconditionFailed");
      this.objects.set(to, { ...o });
    },
    remove: async (key) => {
      this.calls.remove++;
      this.objects.delete(key);
    },
  };
  /** What the browser does with a URL: refused after expiry or with another Content-Type, otherwise stores (and may overwrite). */
  put(url: string, bytes: number, type: string): number {
    const u = this.urls.get(url);
    if (!u || this.now > u.expiresAt || type !== u.type) return 403;
    this.objects.set(u.key, { bytes, type, etag: `"etag-${++this.n}"` });
    return 200;
  }
}

const dbFor = (): UploadDb => {
  const call = async <T>(sql: string, params: unknown[]): Promise<T[]> => {
    await actAs(db(), "service");
    // each real RPC is its own transaction; here the whole test is one, so a savepoint keeps an error from poisoning it
    await db().exec("savepoint rpc");
    try {
      const rows = (await db().query<T>(sql, params)).rows;
      await db().exec("release savepoint rpc");
      return rows;
    } catch (e) {
      await db().exec("rollback to savepoint rpc");
      throw e;
    }
  };
  return {
    async issue(owner, submission, type, bytes) {
      const [r] = await call<{ upload_id: string; expires_at: string }>("select * from public.issue_video_upload($1,$2,$3,$4)", [owner, submission, type, bytes]);
      return { uploadId: r!.upload_id, expiresAt: String(r!.expires_at) };
    },
    async check(owner, upload) {
      const [r] = await call<{ declared_bytes: number; content_type: string }>("select * from public.check_video_upload($1,$2)", [owner, upload]);
      return { bytes: Number(r!.declared_bytes), type: r!.content_type };
    },
    async attach(owner, upload, bytes, type, etag) {
      const [r] = await call<{ attach_video_upload: string | null }>("select public.attach_video_upload($1,$2,$3,$4,$5)", [owner, upload, bytes, type, etag]);
      return { replaced: r!.attach_video_upload };
    },
    async reject(owner, upload, status) {
      await call("select public.reject_video_upload($1,$2,$3)", [owner, upload, status]);
    },
  };
};

const meta = (over: Record<string, unknown> = {}) => ({ type: "video/mp4", bytes: 20 * MB, seconds: 45, ...over });
const sub = async (id: string) => (await q<{ status: string; video_key: string | null }>(db(), "superuser", "select status, video_key from public.submissions where id = $1", [id]))[0]!;
const status = async (id: string) => (await q<{ status: string }>(db(), "superuser", "select status from public.video_uploads where id = $1", [id]))[0]!.status;

function setup() {
  const r2 = new FakeR2();
  return { r2, deps: { store: r2.store, db: dbFor() } };
}
async function started(deps: ReturnType<typeof setup>["deps"], owner: string, submission: string, m = meta()) {
  const s = await startUpload(deps, { ownerId: owner, submissionId: submission, meta: m });
  if (!s.ok) throw new Error(`start failed: ${s.code}`);
  return s;
}

describe("a verified draft uploads a video", () => {
  it("start, PUT, finish: the entry becomes uploaded with the new video, privately", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    const s = await started(deps, ids.parentA, draft);
    expect(s.url).toContain(`/pending/${s.uploadId}`);
    expect(JSON.stringify(s)).not.toContain("videos/"); // the final object name is never handed out
    expect(r2.put(s.url, 20 * MB, "video/mp4")).toBe(200);
    expect(await finishUpload(deps, { ownerId: ids.parentA, uploadId: s.uploadId })).toEqual({ ok: true, replaced: false });

    expect(await sub(draft)).toEqual({ status: "uploaded", video_key: s.uploadId });
    expect([...r2.objects.keys()]).toEqual([`videos/${s.uploadId}`]); // pending/ was emptied
    expect(await status(s.uploadId)).toBe("verified");
  });

  it("never finalizes the entry", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    const s = await started(deps, ids.parentA, draft);
    r2.put(s.url, 20 * MB, "video/mp4");
    await finishUpload(deps, { ownerId: ids.parentA, uploadId: s.uploadId });
    expect((await sub(draft)).status).toBe("uploaded");
    const [row] = await q<{ finalized_at: string | null }>(db(), "superuser", "select finalized_at from public.submissions where id = $1", [draft]);
    expect(row!.finalized_at).toBeNull();
  });

  it("replacing the video swaps the reference and queues the old object for deletion", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    const first = await started(deps, ids.parentA, draft);
    r2.put(first.url, 20 * MB, "video/mp4");
    await finishUpload(deps, { ownerId: ids.parentA, uploadId: first.uploadId });
    const second = await started(deps, ids.parentA, draft, meta({ type: "video/webm", bytes: 30 * MB }));
    r2.put(second.url, 30 * MB, "video/webm");
    expect(await finishUpload(deps, { ownerId: ids.parentA, uploadId: second.uploadId })).toEqual({ ok: true, replaced: true });
    expect(await sub(draft)).toEqual({ status: "uploaded", video_key: second.uploadId });
    expect(await status(first.uploadId)).toBe("superseded");

    const cleaned = await cleanupUploads({
      store: r2.store,
      db: {
        stale: async () => (await q<{ stale_video_uploads: string }>(db(), "service", "select * from public.stale_video_uploads(50)")).map((x) => x.stale_video_uploads),
        markDeleted: async (id) => void (await q(db(), "service", "select public.mark_video_upload_deleted($1)", [id])),
      },
    });
    expect(cleaned).toEqual({ deleted: 1, failed: 0 });
    expect([...r2.objects.keys()]).toEqual([`videos/${second.uploadId}`]); // the attached video is untouched
    expect(await status(first.uploadId)).toBe("deleted");
  });
});

describe("another parent cannot use or attach to someone else's entry", () => {
  it("cannot start an upload for it, and cannot finish an upload that is not theirs", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    expect(await startUpload(deps, { ownerId: ids.parentB, submissionId: draft, meta: meta() })).toEqual({ ok: false, code: "notFound" });
    expect(await startUpload(deps, { ownerId: ids.parentB, submissionId: crypto.randomUUID(), meta: meta() })).toEqual({ ok: false, code: "notFound" }); // same answer
    expect(r2.urls.size).toBe(0); // no URL was ever signed

    const s = await started(deps, ids.parentA, draft);
    r2.put(s.url, 20 * MB, "video/mp4");
    expect(await finishUpload(deps, { ownerId: ids.parentB, uploadId: s.uploadId })).toEqual({ ok: false, code: "notFound" });
    expect((await sub(draft)).video_key).toBeNull();
    expect(r2.objects.has(`pending/${s.uploadId}`)).toBe(true); // B's attempt did not touch A's object
  });

  it("a client cannot choose a storage key: only an id from a real, owned authorization is accepted", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    for (const bad of ["pending/other", "../x", "videos/00000000-0000-4000-8000-000000000000", "", 5, null]) {
      expect(await finishUpload(deps, { ownerId: ids.parentA, uploadId: bad }), String(bad)).toEqual({ ok: false, code: "invalid" });
    }
    expect(await finishUpload(deps, { ownerId: ids.parentA, uploadId: crypto.randomUUID() })).toEqual({ ok: false, code: "notFound" }); // no such authorization
    r2.objects.set("pending/11111111-1111-4111-8111-111111111111", { bytes: 20 * MB, type: "video/mp4", etag: '"planted"' }); // an object with no authorization
    expect(await finishUpload(deps, { ownerId: ids.parentA, uploadId: "11111111-1111-4111-8111-111111111111" })).toEqual({ ok: false, code: "notFound" });
    expect((await sub(draft)).video_key).toBeNull();
  });
});

describe("authorization comes first, and is repeated at the end", () => {
  it("an unauthorized parent makes ZERO requests to the bucket, and learns nothing about another parent's object", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    const s = await started(deps, ids.parentA, draft);
    r2.put(s.url, 20 * MB, "video/mp4"); // A's object exists
    const before = { ...r2.calls };

    const real = await finishUpload(deps, { ownerId: ids.parentB, uploadId: s.uploadId }); // B names A's real, uploaded id
    const fake = await finishUpload(deps, { ownerId: ids.parentB, uploadId: crypto.randomUUID() }); // B names an id that does not exist
    expect(real).toEqual({ ok: false, code: "notFound" });
    expect(fake).toEqual(real); // identical answers: the existence of A's object is not revealed
    expect(r2.calls).toEqual(before); // and the bucket was never asked
    expect(r2.objects.has(`pending/${s.uploadId}`)).toBe(true);
  });

  it("a bucket failure while checking leaves the entry without a video and the authorization usable", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    const s = await started(deps, ids.parentA, draft);
    r2.put(s.url, 20 * MB, "video/mp4");
    const realHead = r2.store.head;
    r2.store.head = async () => {
      throw new Error("R2 503");
    };
    expect(await finishUpload(deps, { ownerId: ids.parentA, uploadId: s.uploadId })).toEqual({ ok: false, code: "unavailable" });
    expect(await sub(draft)).toEqual({ status: "draft", video_key: null });
    expect(await status(s.uploadId)).toBe("issued"); // nothing was consumed
    r2.store.head = realHead;
    expect((await finishUpload(deps, { ownerId: ids.parentA, uploadId: s.uploadId })).ok).toBe(true); // a retry of the confirmation succeeds
  });

  it("authorization is re-checked at the moment of attaching: if registration closes after the bucket check, nothing is attached", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    const s = await started(deps, ids.parentA, draft);
    r2.put(s.url, 20 * MB, "video/mp4");
    const realCopy = r2.store.copy;
    r2.store.copy = async (from, to, etag) => {
      await realCopy(from, to, etag);
      await actAs(db(), "superuser"); // the administrator closes registration while the copy is in flight
      await db().exec("update public.event_settings set submissions_close_at = now() - interval '1 minute', submissions_open_at = now() - interval '2 days'");
    };
    expect(await finishUpload(deps, { ownerId: ids.parentA, uploadId: s.uploadId })).toEqual({ ok: false, code: "closed" });
    expect(await sub(draft)).toEqual({ status: "draft", video_key: null });
    expect(r2.objects.has(`videos/${s.uploadId}`)).toBe(false); // the copied object was removed
    expect(await status(s.uploadId)).toBe("rejected");
  });

  it("authorization is re-checked at attach: an authorization replaced after the check cannot be attached", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    const first = await started(deps, ids.parentA, draft);
    r2.put(first.url, 20 * MB, "video/mp4");
    const realCopy = r2.store.copy;
    let second: string | null = null;
    r2.store.copy = async (from, to, etag) => {
      await realCopy(from, to, etag);
      second = (await started(deps, ids.parentA, draft)).uploadId; // a newer authorization supersedes the first, mid-flight
    };
    expect(await finishUpload(deps, { ownerId: ids.parentA, uploadId: first.uploadId })).toEqual({ ok: false, code: "notCurrent" });
    expect((await sub(draft)).video_key).toBeNull();
    expect(await status(second!)).toBe("issued"); // the newer authorization is untouched
  });
});

describe("what is stored must match what was declared", () => {
  it("rejects and deletes an oversize object uploaded with a valid URL", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    const s = await started(deps, ids.parentA, draft);
    r2.put(s.url, 150 * MB, "video/mp4"); // R2 cannot cap a presigned PUT, so the server must
    expect(await finishUpload(deps, { ownerId: ids.parentA, uploadId: s.uploadId })).toEqual({ ok: false, code: "tooBig" });
    expect(r2.objects.size).toBe(0);
    expect(await status(s.uploadId)).toBe("rejected");
    expect((await sub(draft)).status).toBe("draft");
  });

  it("rejects an object whose size differs from the declaration", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    const s = await started(deps, ids.parentA, draft);
    r2.put(s.url, 5 * MB, "video/mp4");
    expect(await finishUpload(deps, { ownerId: ids.parentA, uploadId: s.uploadId })).toEqual({ ok: false, code: "mismatch" });
    expect(r2.objects.size).toBe(0);
    expect((await sub(draft)).video_key).toBeNull();
  });

  it("a PUT with another Content-Type is refused by the bucket, and a stored type that differs is rejected", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    const s = await started(deps, ids.parentA, draft);
    expect(r2.put(s.url, 20 * MB, "text/html")).toBe(403);
    r2.objects.set(`pending/${s.uploadId}`, { bytes: 20 * MB, type: "video/webm", etag: '"x"' }); // as if the signature were bypassed
    expect(await finishUpload(deps, { ownerId: ids.parentA, uploadId: s.uploadId })).toEqual({ ok: false, code: "mismatch" });
    expect(r2.objects.size).toBe(0);
  });

  it("an object swapped between the check and the copy is not accepted", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    const s = await started(deps, ids.parentA, draft);
    r2.put(s.url, 20 * MB, "video/mp4");
    const realCopy = r2.store.copy;
    r2.store.copy = async (from, to, etag) => {
      r2.put(s.url, 20 * MB, "video/mp4"); // the bearer URL is used again between HeadObject and the copy
      return realCopy(from, to, etag);
    };
    expect(await finishUpload(deps, { ownerId: ids.parentA, uploadId: s.uploadId })).toEqual({ ok: false, code: "mismatch" });
    expect((await sub(draft)).video_key).toBeNull();
    expect(r2.objects.has(`videos/${s.uploadId}`)).toBe(false);
  });
});

describe("authorizations are temporary and single use", () => {
  it("an expired URL is refused by the bucket, so nothing is stored and finishing reports it was not uploaded", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    const s = await started(deps, ids.parentA, draft);
    r2.now += 16 * 60_000;
    expect(r2.put(s.url, 20 * MB, "video/mp4")).toBe(403);
    expect(await finishUpload(deps, { ownerId: ids.parentA, uploadId: s.uploadId })).toEqual({ ok: false, code: "missing" });
  });

  it("an authorization that is attached late (past expiry plus grace) is refused", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    const s = await started(deps, ids.parentA, draft);
    r2.put(s.url, 20 * MB, "video/mp4");
    await actAs(db(), "superuser");
    await db().query("update public.video_uploads set expires_at = now() - interval '11 minutes' where id = $1", [s.uploadId]);
    const before = r2.calls.head;
    expect(await finishUpload(deps, { ownerId: ids.parentA, uploadId: s.uploadId })).toEqual({ ok: false, code: "expired" });
    expect(r2.calls.head).toBe(before); // turned away by the database: the bucket was not asked
    expect((await sub(draft)).video_key).toBeNull();
    expect(r2.objects.has(`videos/${s.uploadId}`)).toBe(false);
  });

  it("a finished authorization cannot be finished again, and re-using its URL cannot change the verified video", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    const s = await started(deps, ids.parentA, draft);
    r2.put(s.url, 20 * MB, "video/mp4");
    await finishUpload(deps, { ownerId: ids.parentA, uploadId: s.uploadId });
    const verified = r2.objects.get(`videos/${s.uploadId}`)!;

    const headsBefore = r2.calls.head;
    expect(await finishUpload(deps, { ownerId: ids.parentA, uploadId: s.uploadId })).toEqual({ ok: false, code: "notCurrent" }); // reuse is refused by the database,
    expect(r2.calls.head).toBe(headsBefore); // before the bucket is contacted
    r2.put(s.url, 90 * MB, "video/mp4"); // the bearer URL still works until it expires, but only reaches pending/
    expect(r2.objects.get(`videos/${s.uploadId}`)).toEqual(verified);
    expect(await finishUpload(deps, { ownerId: ids.parentA, uploadId: s.uploadId })).toEqual({ ok: false, code: "notCurrent" });
    expect((await sub(draft)).video_key).toBe(s.uploadId);
  });

  it("a retry gets a fresh key and the first authorization can no longer be finished", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    const first = await started(deps, ids.parentA, draft);
    r2.put(first.url, 20 * MB, "video/mp4"); // the first attempt did upload, but the browser never confirmed
    const second = await started(deps, ids.parentA, draft);
    expect(second.uploadId).not.toBe(first.uploadId);
    expect(second.url).not.toBe(first.url);
    expect(await finishUpload(deps, { ownerId: ids.parentA, uploadId: first.uploadId })).toEqual({ ok: false, code: "notCurrent" });
    expect(await status(first.uploadId)).toBe("superseded");
    r2.put(second.url, 20 * MB, "video/mp4");
    expect((await finishUpload(deps, { ownerId: ids.parentA, uploadId: second.uploadId })).ok).toBe(true);
    expect((await sub(draft)).video_key).toBe(second.uploadId);
  });
});

describe("registration rules still apply", () => {
  it("no upload is signed for an invalid declaration, a closed window, a withdrawn entry or a bad id", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    for (const [m, code] of [
      [meta({ type: "application/pdf" }), "type"],
      [meta({ bytes: 101 * MB }), "tooBig"],
      [meta({ seconds: 10 }), "tooShort"],
      [meta({ seconds: 200 }), "tooLong"],
      [meta({ seconds: null }), "unreadable"],
      [{ type: 5 }, "invalid"],
    ] as const) {
      expect(await startUpload(deps, { ownerId: ids.parentA, submissionId: draft, meta: m }), code).toEqual({ ok: false, code });
    }
    expect(await startUpload(deps, { ownerId: ids.parentA, submissionId: "not-a-uuid", meta: meta() })).toEqual({ ok: false, code: "invalid" });
    expect(r2.urls.size).toBe(0);

    await actAs(db(), "superuser");
    await db().exec("update public.event_settings set submissions_close_at = now() - interval '1 minute', submissions_open_at = now() - interval '2 days'");
    expect(await startUpload(deps, { ownerId: ids.parentA, submissionId: draft, meta: meta() })).toEqual({ ok: false, code: "closed" });
    await db().exec("update public.event_settings set submissions_close_at = now() + interval '1 day'");
    await db().query("update public.submissions set status = 'withdrawn' where id = $1", [draft]);
    expect(await startUpload(deps, { ownerId: ids.parentA, submissionId: draft, meta: meta() })).toEqual({ ok: false, code: "locked" });
    expect(r2.urls.size).toBe(0);
  });

  it("issuance is bounded: the ninth request in an hour for one entry is refused", async () => {
    const { deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    for (let i = 0; i < 8; i++) await started(deps, ids.parentA, draft);
    expect(await startUpload(deps, { ownerId: ids.parentA, submissionId: draft, meta: meta() })).toEqual({ ok: false, code: "tooMany" });
  });

  it("a signing failure leaves no usable authorization behind", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA });
    r2.store.presignPut = async () => {
      throw new Error("R2 is down");
    };
    expect(await startUpload(deps, { ownerId: ids.parentA, submissionId: draft, meta: meta() })).toEqual({ ok: false, code: "unavailable" });
    const rows = await q<{ status: string }>(db(), "superuser", "select status from public.video_uploads where submission_id = $1", [draft]);
    expect(rows.map((x) => x.status)).toEqual(["abandoned"]);
  });
});

describe("privacy of what leaves the service", () => {
  it("results and thrown errors contain no email, name, mobile or secret", async () => {
    const { r2, deps } = setup();
    const draft = await insertDraft(db(), { owner: ids.parentA, childName: "Zorathustra Quillfeather", email: "ottoline@example.test" });
    const s = await started(deps, ids.parentA, draft);
    r2.put(s.url, 150 * MB, "video/mp4");
    const failure = await finishUpload(deps, { ownerId: ids.parentA, uploadId: s.uploadId });
    const everything = JSON.stringify([s, failure]);
    expect(everything).not.toMatch(/Zorathustra|Quillfeather|ottoline|example\.test|9876543210/i);
    expect(everything).not.toMatch(/secret|password|service_role/i);
  });
});
