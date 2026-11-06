import { describe, expect, it } from "vitest";
import type { ObjectHead } from "@/lib/storage/object-store";
import { finalizeEntry, type FinalizeDb, type FinalizeDeps } from "@/lib/submit/service";
import { actAs, ids, insertDraft, q, setupDb, uploadVerified } from "./helpers";

// M4B final submission end to end: the REAL service code against the REAL database functions (PGlite) with a fake private
// bucket that answers HeadObject. This proves our logic and ordering. A real bucket is UNVERIFIED until approved, and one
// PGlite connection cannot prove true parallel locking; the locking itself is covered by supabase/tests/finalize.test.ts.

const db = setupDb();
const EVENT = 2; // insertDraft's default competition

class FakeBucket {
  objects = new Map<string, ObjectHead>();
  heads = 0;
  failNext = false;
  store: FinalizeDeps["store"] = {
    head: async (key) => {
      this.heads++;
      if (this.failNext) {
        this.failNext = false;
        throw new Error("R2 503 https://acct.r2.cloudflarestorage.com");
      }
      return this.objects.get(key) ?? null;
    },
  };
}

// One connection: run the database calls one at a time, each in a savepoint so an expected error does not poison the test's transaction.
let chain: Promise<unknown> = Promise.resolve();
function call<T>(sql: string, params: unknown[]): Promise<T[]> {
  const run = async () => {
    await actAs(db(), "service");
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
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}

const realDb = (hooks: { beforeFinalize?: () => Promise<void> } = {}): FinalizeDb => ({
  async check(owner, submission) {
    const [r] = await call<{ upload_id: string; bytes: string; content_type: string; etag: string; event_id: number; consent_version: string; already: boolean }>("select * from public.check_finalize($1,$2)", [owner, submission]);
    return { uploadId: r!.upload_id, bytes: Number(r!.bytes), type: r!.content_type, etag: r!.etag, eventId: r!.event_id, consentVersion: r!.consent_version, already: r!.already };
  },
  async finalize(owner, submission, upload, bytes, type, etag) {
    await hooks.beforeFinalize?.();
    const [r] = await call<{ finalize_verified_submission: "finalized" | "already_finalized" }>("select public.finalize_verified_submission($1,$2,$3,$4,$5,$6)", [owner, submission, upload, bytes, type, etag]);
    return r!.finalize_verified_submission;
  },
});

const deps = (bucket: FakeBucket, database: FinalizeDb = realDb()): FinalizeDeps => ({ store: bucket.store, db: database, consentKnown: (v) => v === "v1" });
const submit = (d: FinalizeDeps, owner: string, submissionId: string, eventId = EVENT) => finalizeEntry(d, { ownerId: owner, submissionId, eventId });
const row = async (id: string) => (await q<{ status: string; finalized_at: string | null }>(db(), "superuser", "select status, finalized_at from public.submissions where id = $1", [id]))[0]!;

/** A draft taken through the real upload functions, with the bucket holding exactly the verified object. */
async function ready(bucket: FakeBucket, over: { owner?: string; name?: string; mobile?: string; event?: number } = {}) {
  const owner = over.owner ?? ids.parentA;
  const id = await insertDraft(db(), { owner, childName: over.name ?? "Asha", mobile: over.mobile, event: over.event });
  const v = await uploadVerified(db(), owner, id);
  bucket.objects.set(`videos/${v.upload}`, { bytes: v.bytes, contentType: v.type, etag: v.etag });
  return { owner, id, v };
}
const closeWindow = async () => {
  await actAs(db(), "superuser");
  await db().exec("update public.event_settings set submissions_close_at = now() - interval '1 minute', submissions_open_at = now() - interval '2 days'");
};

describe("a valid final submission", () => {
  it("finalizes the entry, asks the bucket once, and returns nothing sensitive", async () => {
    const bucket = new FakeBucket();
    const { owner, id } = await ready(bucket);
    const res = await submit(deps(bucket), owner, id);
    expect(res).toEqual({ ok: true, already: false });
    expect(bucket.heads).toBe(1);
    const r = await row(id);
    expect(r.status).toBe("finalized");
    expect(r.finalized_at).not.toBeNull();
  });

  it("is idempotent: repeating it succeeds as 'already', with no second bucket request and an unchanged timestamp", async () => {
    const bucket = new FakeBucket();
    const { owner, id } = await ready(bucket);
    await submit(deps(bucket), owner, id);
    const first = await row(id);
    expect(await submit(deps(bucket), owner, id)).toEqual({ ok: true, already: true });
    expect(bucket.heads).toBe(1);
    expect(await row(id)).toEqual(first);
  });

  it("two requests at once end with one finalized entry: one is the transition, the other is 'already'", async () => {
    const bucket = new FakeBucket();
    const { owner, id } = await ready(bucket);
    const d = deps(bucket);
    const results = await Promise.all([submit(d, owner, id), submit(d, owner, id)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && !r.already)).toHaveLength(1);
    expect((await row(id)).status).toBe("finalized");
    const n = await q<{ n: string }>(db(), "superuser", "select count(*)::int as n from public.submissions where status = 'finalized'");
    expect(Number(n[0]!.n)).toBe(1);
  });
});

describe("nothing changes when the object is not the verified one", () => {
  it("a missing object", async () => {
    const bucket = new FakeBucket();
    const { owner, id } = await ready(bucket);
    bucket.objects.clear();
    expect(await submit(deps(bucket), owner, id)).toEqual({ ok: false, code: "videoMissing" });
    expect((await row(id)).status).toBe("uploaded");
  });

  it("a different ETag, size or type", async () => {
    for (const change of [{ etag: '"replaced"' }, { bytes: 21 * 1024 * 1024 }, { contentType: "video/webm" }]) {
      const bucket = new FakeBucket();
      const { owner, id, v } = await ready(bucket);
      bucket.objects.set(`videos/${v.upload}`, { bytes: v.bytes, contentType: v.type, etag: v.etag, ...change });
      expect(await submit(deps(bucket), owner, id), JSON.stringify(change)).toEqual({ ok: false, code: "videoChanged" });
      expect((await row(id)).status).toBe("uploaded");
    }
  });

  it("the object changing between the bucket check and the transition is caught by the database", async () => {
    const bucket = new FakeBucket();
    const { owner, id, v } = await ready(bucket);
    // the bucket answered with the verified values, but the database record was replaced by a newer verified upload meanwhile
    const racing = realDb({
      beforeFinalize: async () => {
        await uploadVerified(db(), owner, id, { etag: '"newer"' });
      },
    });
    const res = await submit(deps(bucket, racing), owner, id);
    expect(res.ok).toBe(false);
    expect((await row(id)).status).toBe("uploaded");
    expect(v.etag).not.toBe('"newer"');
  });

  it("a bucket failure is plain 'unavailable', changes nothing, and a retry then works", async () => {
    const bucket = new FakeBucket();
    const { owner, id } = await ready(bucket);
    bucket.failNext = true;
    const res = await submit(deps(bucket), owner, id);
    expect(res).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(res)).not.toMatch(/r2|cloudflare/i);
    expect((await row(id)).status).toBe("uploaded");
    expect(await submit(deps(bucket), owner, id)).toEqual({ ok: true, already: false });
  });
});

describe("the database refuses, and the bucket is not contacted for what the database can already refuse", () => {
  it("a draft with no video", async () => {
    const bucket = new FakeBucket();
    const id = await insertDraft(db(), { owner: ids.parentA });
    expect((await submit(deps(bucket), ids.parentA, id)).ok).toBe(false);
    expect(bucket.heads).toBe(0);
  });

  it("another parent's entry is 'not found', exactly like an entry that does not exist", async () => {
    const bucket = new FakeBucket();
    const { id } = await ready(bucket);
    const other = await submit(deps(bucket), ids.parentB, id);
    const missing = await submit(deps(bucket), ids.parentB, "00000000-0000-4000-8000-000000000000");
    expect(other).toEqual({ ok: false, code: "notFound" });
    expect(missing).toEqual(other);
    expect(bucket.heads).toBe(0);
    expect((await row(id)).status).toBe("uploaded");
  });

  it("an entry from another competition than the page's", async () => {
    const bucket = new FakeBucket();
    const { owner, id } = await ready(bucket);
    expect(await submit(deps(bucket), owner, id, EVENT + 1)).toEqual({ ok: false, code: "notFound" });
    expect(bucket.heads).toBe(0);
  });

  it("the registration window closed", async () => {
    const bucket = new FakeBucket();
    const { owner, id } = await ready(bucket);
    await closeWindow();
    expect(await submit(deps(bucket), owner, id)).toEqual({ ok: false, code: "closed" });
    expect(bucket.heads).toBe(0);
    expect((await row(id)).status).toBe("uploaded");
  });

  it("a second entry for the same child after the first was submitted, even from another parent's account", async () => {
    const bucket = new FakeBucket();
    const first = await ready(bucket, { owner: ids.parentA, name: "Asha", mobile: "+91 98765 43210" });
    expect(await submit(deps(bucket), first.owner, first.id)).toEqual({ ok: true, already: false });
    const second = await ready(bucket, { owner: ids.parentB, name: "Asha", mobile: "+91 98765 43210", event: 3 });
    expect(await submit(deps(bucket), second.owner, second.id, 3)).toEqual({ ok: false, code: "duplicate" });
    expect((await row(second.id)).status).toBe("uploaded");
  });

  it("a database failure at the transition is 'unavailable', leaks nothing, and changes nothing", async () => {
    const bucket = new FakeBucket();
    const { owner, id } = await ready(bucket);
    const broken: FinalizeDb = { ...realDb(), finalize: async () => { throw new Error("deadlock detected password=hunter2"); } };
    const res = await submit(deps(bucket, broken), owner, id);
    expect(res).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(res)).not.toMatch(/hunter2|deadlock/);
    expect((await row(id)).status).toBe("uploaded");
  });
});
