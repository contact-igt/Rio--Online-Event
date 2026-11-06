import { describe, expect, it } from "vitest";
import { actAs, fails, ids, insertDraft, PG, q, setupDb, uploadVerified, type Who } from "./helpers";

// M4B: final submission happens only through two service-role-only functions. check_finalize authorizes before the bucket is
// touched; finalize_verified_submission is the single atomic transition and compares the object's CURRENT size, type and ETag
// with the verified record. Real Postgres roles; the bucket is represented by the values the server would read from HeadObject.

const db = setupDb();

type Check = { upload_id: string | null; bytes: number | null; content_type: string | null; etag: string | null; event_id: number; consent_version: string; already: boolean };
const check = (owner: string, sub: string) => q<Check>(db(), "service", "select * from public.check_finalize($1,$2)", [owner, sub]);
const checkFails = async (owner: string, sub: string) => (await fails(db(), "service", "select * from public.check_finalize($1,$2)", [owner, sub])).message;
const fin = (owner: string, sub: string, v: { upload: string; bytes: number; type: string; etag: string }) =>
  q<{ finalize_verified_submission: string }>(db(), "service", "select public.finalize_verified_submission($1,$2,$3,$4,$5,$6)", [owner, sub, v.upload, v.bytes, v.type, v.etag]).then((r) => r[0]!.finalize_verified_submission);
const finFails = async (owner: string, sub: string, v: { upload: string; bytes: number; type: string; etag: string }) =>
  (await fails(db(), "service", "select public.finalize_verified_submission($1,$2,$3,$4,$5,$6)", [owner, sub, v.upload, v.bytes, v.type, v.etag])).message;
const status = async (id: string) => (await q<{ status: string; video_key: string | null }>(db(), "superuser", "select status, video_key from public.submissions where id = $1", [id]))[0]!;
const closeWindow = async () => {
  await actAs(db(), "superuser");
  await db().exec("update public.event_settings set submissions_close_at = now() - interval '1 minute', submissions_open_at = now() - interval '2 days'");
};
async function readyEntry(over: { owner?: string; name?: string; mobile?: string; email?: string; event?: number } = {}) {
  const owner = over.owner ?? ids.parentA;
  const id = await insertDraft(db(), { owner, childName: over.name ?? "Asha", mobile: over.mobile, email: over.email ?? "a@example.test", event: over.event });
  const v = await uploadVerified(db(), owner, id);
  return { owner, id, v };
}

describe("only the server can finalize", () => {
  it("nobody but service_role may call either function: not anon, a parent, an admin or a judge", async () => {
    const { id, v } = await readyEntry();
    for (const who of ["anon", "parentA", "parentB", "admin", "judge1"] as const satisfies readonly Who[]) {
      expect((await fails(db(), who, "select * from public.check_finalize($1,$2)", [ids.parentA, id])).code, who).toBe(PG.insufficientPrivilege);
      expect((await fails(db(), who, "select public.finalize_verified_submission($1,$2,$3,$4,$5,$6)", [ids.parentA, id, v.upload, v.bytes, v.type, v.etag])).code, who).toBe(PG.insufficientPrivilege);
    }
  });

  it("the old parent-callable finalizer no longer exists, and nobody can write the status directly", async () => {
    const { id } = await readyEntry();
    expect((await fails(db(), "parentA", "select public.finalize_submission($1)", [id])).code).toBe("42883");
    expect((await fails(db(), "service", "select public.finalize_submission($1)", [id])).code).toBe("42883");
    for (const who of ["parentA", "parentB", "admin", "judge1", "anon"] as const) {
      expect((await fails(db(), who, "update public.submissions set status = 'finalized' where id = $1", [id])).code, who).toBe(PG.insufficientPrivilege);
    }
    expect((await status(id)).status).toBe("uploaded");
  });
});

describe("check_finalize authorizes before the bucket is contacted", () => {
  it("returns the verified record for the owner's own uploaded entry, and changes nothing", async () => {
    const { owner, id, v } = await readyEntry();
    const [row] = await check(owner, id);
    expect(row).toMatchObject({ upload_id: v.upload, bytes: v.bytes, content_type: v.type, etag: v.etag, already: false, consent_version: "v1" });
    expect(Number(row!.event_id)).toBe(2);
    expect((await status(id)).status).toBe("uploaded");
  });

  it("gives a stranger and a missing entry the very same answer", async () => {
    const { id } = await readyEntry();
    const stranger = await checkFails(ids.parentB, id);
    const missing = await checkFails(ids.parentB, "99999999-9999-4999-8999-999999999999");
    expect(stranger).toContain("not_found");
    expect(stranger).toBe(missing);
  });

  it("refuses a draft (no video uploaded yet)", async () => {
    const draft = await insertDraft(db(), { owner: ids.parentA, childName: "Draft" });
    expect(await checkFails(ids.parentA, draft)).toContain("invalid_status_transition");
  });

  it("an uploaded entry whose video row is not verified, or is missing, is refused", async () => {
    const e = await insertDraft(db(), { owner: ids.parentA, childName: "Orphan", email: "o@example.test" });
    await actAs(db(), "superuser");
    await db().query("update public.submissions set status='uploaded', video_key=gen_random_uuid() where id=$1", [e]); // a key with no verified upload row
    expect(await checkFails(ids.parentA, e)).toContain("video_not_verified");
  });

  it("a closed window and a withdrawn entry are refused", async () => {
    const { owner, id } = await readyEntry();
    await closeWindow();
    expect(await checkFails(owner, id)).toContain("submissions_closed");
    await actAs(db(), "superuser");
    await db().exec("update public.event_settings set submissions_close_at = now() + interval '1 day'");
    await db().query("update public.submissions set status='withdrawn' where id=$1", [id]);
    expect(await checkFails(owner, id)).toContain("invalid_status_transition");
  });

  it("answers an already-final entry with already=true, even after the window has closed", async () => {
    const { owner, id, v } = await readyEntry();
    expect(await fin(owner, id, v)).toBe("finalized");
    await closeWindow();
    const [row] = await check(owner, id);
    expect(row).toMatchObject({ already: true, upload_id: v.upload });
  });
});

describe("finalize_verified_submission is the one atomic transition", () => {
  it("finalizes an uploaded entry whose bucket object still matches the verified record", async () => {
    const { owner, id, v } = await readyEntry();
    expect(await fin(owner, id, v)).toBe("finalized");
    const s = await status(id);
    expect(s).toEqual({ status: "finalized", video_key: v.upload });
    const [stamp] = await q<{ finalized_at: string | null }>(db(), "superuser", "select finalized_at from public.submissions where id = $1", [id]);
    expect(stamp!.finalized_at).not.toBeNull();
  });

  it("is idempotent: asking again returns already_finalized and changes nothing", async () => {
    const { owner, id, v } = await readyEntry();
    await fin(owner, id, v);
    const [before] = await q<{ finalized_at: string; updated_at: string }>(db(), "superuser", "select finalized_at, updated_at from public.submissions where id = $1", [id]);
    expect(await fin(owner, id, v)).toBe("already_finalized");
    expect(await fin(owner, id, v)).toBe("already_finalized");
    const [after] = await q<{ finalized_at: string; updated_at: string }>(db(), "superuser", "select finalized_at, updated_at from public.submissions where id = $1", [id]);
    expect(after).toEqual(before);
  });

  it("refuses a bucket object whose size, type or ETag differs from the verified record, and leaves the entry uploaded", async () => {
    const { owner, id, v } = await readyEntry();
    expect(await finFails(owner, id, { ...v, bytes: v.bytes + 1 })).toContain("video_changed");
    expect(await finFails(owner, id, { ...v, type: "video/webm" })).toContain("video_changed");
    expect(await finFails(owner, id, { ...v, etag: '"a-different-object"' })).toContain("video_changed");
    expect((await status(id)).status).toBe("uploaded");
  });

  it("refuses another parent's entry (same answer as a missing one), and an upload that is not this entry's video", async () => {
    const { owner, id, v } = await readyEntry();
    expect(await finFails(ids.parentB, id, v)).toContain("not_found");
    expect(await finFails(owner, "99999999-9999-4999-8999-999999999999", v)).toContain("not_found");
    const other = await readyEntry({ owner: ids.parentB, name: "Other", email: "b@example.test", mobile: "9123456780" });
    expect(await finFails(owner, id, { ...v, upload: other.v.upload })).toContain("video_not_verified"); // someone else's upload
    expect(await finFails(owner, id, { ...v, upload: "99999999-9999-4999-8999-999999999999" })).toContain("video_not_verified");
    expect((await status(id)).status).toBe("uploaded");
  });

  it("refuses a superseded video: after a replacement only the current upload can be finalized", async () => {
    const { owner, id, v: first } = await readyEntry();
    const second = await uploadVerified(db(), owner, id, { etag: '"second"' });
    expect(await finFails(owner, id, first)).toContain("video_not_verified");
    expect(await fin(owner, id, second)).toBe("finalized");
  });

  it("refuses when the registration window is closed, and when the entry is withdrawn", async () => {
    const a = await readyEntry();
    await closeWindow();
    expect(await finFails(a.owner, a.id, a.v)).toContain("submissions_closed");
    await actAs(db(), "superuser");
    await db().exec("update public.event_settings set submissions_close_at = now() + interval '1 day'");
    await db().query("update public.submissions set status='withdrawn' where id=$1", [a.id]);
    expect(await finFails(a.owner, a.id, a.v)).toContain("invalid_status_transition");
  });

  it("enforces one finalized entry per child, across parents and competitions, with a generic error", async () => {
    const first = await readyEntry({ name: "Ravi Kumar", mobile: "9876543210" });
    const second = await readyEntry({ owner: ids.parentB, name: "Ravi Kumar", mobile: "9876543210", email: "b@example.test", event: 5 });
    expect(await fin(first.owner, first.id, first.v)).toBe("finalized");
    const e = await fails(db(), "service", "select public.finalize_verified_submission($1,$2,$3,$4,$5,$6)", [second.owner, second.id, second.v.upload, second.v.bytes, second.v.type, second.v.etag]);
    expect(e.code).toBe(PG.uniqueViolation);
    expect(e.message).toBe("duplicate_entry");
    expect((await status(second.id)).status).toBe("uploaded"); // the failed attempt changed nothing
  });

  it("after finalization a parent cannot edit the entry, replace its video, withdraw it or start another upload", async () => {
    const { owner, id, v } = await readyEntry();
    await fin(owner, id, v);
    expect(await q(db(), "parentA", "update public.submissions set child_name = 'Changed' where id = $1 returning id", [id])).toEqual([]);
    expect((await fails(db(), "parentA", "select public.withdraw_submission($1)", [id])).message).toBe("not_found");
    expect((await fails(db(), "service", "select * from public.issue_video_upload($1,$2,'video/mp4',20971520)", [owner, id])).message).toContain("submission_locked");
    expect((await status(id)).video_key).toBe(v.upload);
  });

  it("the status change is audited with ids and states only", async () => {
    const { owner, id, v } = await readyEntry({ email: "private.person@example.test", name: "Zorathustra" });
    await fin(owner, id, v);
    const log = await q<{ details: unknown }>(db(), "superuser", "select details from public.audit_log where table_name = 'submissions' and row_id = $1 order by id", [id]);
    expect(JSON.stringify(log.map((l) => l.details))).toContain("finalized");
    expect(JSON.stringify(log)).not.toMatch(/private\.person|Zorathustra|9876/);
  });
});
