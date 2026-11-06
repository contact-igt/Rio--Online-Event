import { describe, expect, it } from "vitest";
import { actAs, fails, ids, insertDraft, PG, q, setupDb, type Who } from "./helpers";

// M4A: the upload bookkeeping functions. Real Postgres roles: only service_role may call them, and they re-check
// ownership, status and the registration window themselves.

const db = setupDb();
const MB = 1024 * 1024;

type Issued = { upload_id: string; expires_at: string };
const issue = (who: Who, owner: string, sub: string, type = "video/mp4", bytes = 20 * MB) =>
  q<Issued>(db(), who, "select * from public.issue_video_upload($1,$2,$3,$4)", [owner, sub, type, bytes]);
const attach = (owner: string, upload: string, bytes = 20 * MB, etag = "etag-1", type = "video/mp4") =>
  q<{ attach_video_upload: string | null }>(db(), "service", "select public.attach_video_upload($1,$2,$3,$4,$5)", [owner, upload, bytes, type, etag]);
const sub = async (id: string) => (await q<{ status: string; video_key: string | null }>(db(), "superuser", "select status, video_key from public.submissions where id = $1", [id]))[0]!;
const upload = async (id: string) => (await q<{ status: string }>(db(), "superuser", "select status from public.video_uploads where id = $1", [id]))[0]!;
const closeWindow = async () => {
  await actAs(db(), "superuser");
  await db().exec("update public.event_settings set submissions_close_at = now() - interval '1 minute', submissions_open_at = now() - interval '2 days'");
};

describe("who may call the upload functions", () => {
  it("nobody but service_role: not anon, not a parent, an admin or a judge", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    for (const who of ["anon", "parentA", "parentB", "admin", "judge1"] as const) {
      expect((await fails(db(), who, "select * from public.issue_video_upload($1,$2,'video/mp4',20971520)", [ids.parentA, id])).code, who).toBe(PG.insufficientPrivilege);
      expect((await fails(db(), who, "select public.attach_video_upload($1,$2,20971520,'video/mp4','x')", [ids.parentA, id])).code, who).toBe(PG.insufficientPrivilege);
      expect((await fails(db(), who, "select public.stale_video_uploads(10)")).code, who).toBe(PG.insufficientPrivilege);
      expect((await fails(db(), who, "select * from public.check_video_upload($1,$2)", [ids.parentA, id])).code, who).toBe(PG.insufficientPrivilege);
    }
  });

  it("the table itself is closed to every API role", async () => {
    for (const who of ["anon", "parentA", "admin", "judge1"] as const) {
      expect((await fails(db(), who, "select * from public.video_uploads")).code, who).toBe(PG.insufficientPrivilege);
      expect((await fails(db(), who, "insert into public.video_uploads (submission_id, owner_id, content_type, declared_bytes, expires_at) values (gen_random_uuid(), $1, 'video/mp4', 200000, now())", [ids.parentA])).code, who).toBe(PG.insufficientPrivilege);
    }
  });

  it("a parent still cannot set video_key or status directly (unchanged from M2)", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    expect((await fails(db(), "parentA", "update public.submissions set video_key = gen_random_uuid() where id = $1", [id])).code).toBe(PG.insufficientPrivilege);
    expect((await fails(db(), "parentA", "update public.submissions set status = 'uploaded' where id = $1", [id])).code).toBe(PG.insufficientPrivilege);
  });
});

describe("issuing an upload authorization", () => {
  it("creates a random opaque id and a 15-minute expiry for the owner's own draft", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    const [row] = await issue("service", ids.parentA, id);
    expect(row!.upload_id).toMatch(/^[0-9a-f-]{36}$/);
    const ttlMin = (new Date(row!.expires_at).getTime() - Date.now()) / 60_000;
    expect(ttlMin).toBeGreaterThan(14);
    expect(ttlMin).toBeLessThanOrEqual(15.1);
    expect((await upload(row!.upload_id)).status).toBe("issued");
    expect((await sub(id)).video_key).toBeNull(); // issuing attaches nothing
  });

  it("refuses another parent's entry and a missing entry with the same answer", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    const other = (await fails(db(), "service", "select * from public.issue_video_upload($1,$2,'video/mp4',20971520)", [ids.parentB, id])).message;
    const missing = (await fails(db(), "service", "select * from public.issue_video_upload($1,gen_random_uuid(),'video/mp4',20971520)", [ids.parentB])).message;
    expect(other).toContain("not_found");
    expect(missing).toContain("not_found");
  });

  it("refuses bad types and sizes, a closed window and a withdrawn entry", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    for (const [type, bytes] of [["application/pdf", 20 * MB], ["video/mp4", 100 * MB + 1], ["video/mp4", 1000], ["video/mp4", 0], ["text/html", 20 * MB]] as const) {
      expect((await fails(db(), "service", "select * from public.issue_video_upload($1,$2,$3,$4)", [ids.parentA, id, type, bytes])).message, `${type} ${bytes}`).toContain("invalid_video");
    }
    expect((await issue("service", ids.parentA, id, "video/mp4", 100 * MB))).toHaveLength(1); // the limit itself is allowed
    await closeWindow();
    expect((await fails(db(), "service", "select * from public.issue_video_upload($1,$2,'video/mp4',20971520)", [ids.parentA, id])).message).toContain("submissions_closed");
  });

  it("a new authorization retires the older unused one, and issuance is bounded", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    const [first] = await issue("service", ids.parentA, id);
    const [second] = await issue("service", ids.parentA, id);
    expect((await upload(first!.upload_id)).status).toBe("superseded");
    expect((await upload(second!.upload_id)).status).toBe("issued");
    for (let i = 0; i < 6; i++) await issue("service", ids.parentA, id);
    expect((await fails(db(), "service", "select * from public.issue_video_upload($1,$2,'video/mp4',20971520)", [ids.parentA, id])).message).toContain("too_many_uploads");
  });

  it("is written to the audit log with ids and states only", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    const [row] = await issue("service", ids.parentA, id);
    const log = await q<{ row_id: string; details: unknown }>(db(), "superuser", "select row_id, details from public.audit_log where table_name = 'video_uploads' and row_id = $1", [row!.upload_id]);
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log[0]!.details)).not.toMatch(/example\.test|Asha|Parent Test|9876/);
  });
});

describe("checking an authorization before the bucket is touched", () => {
  const check = (owner: string, upload: string) => q<{ declared_bytes: number; content_type: string }>(db(), "service", "select * from public.check_video_upload($1,$2)", [owner, upload]);
  const checkFails = async (owner: string, upload: string) => (await fails(db(), "service", "select * from public.check_video_upload($1,$2)", [owner, upload])).message;

  it("returns what was declared for the owner's own live authorization, and changes nothing", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    const [row] = await issue("service", ids.parentA, id, "video/webm", 33 * MB);
    expect(await check(ids.parentA, row!.upload_id)).toEqual([{ declared_bytes: 33 * MB, content_type: "video/webm" }]);
    expect((await upload(row!.upload_id)).status).toBe("issued");
    expect(await sub(id)).toEqual({ status: "draft", video_key: null });
  });

  it("gives a stranger and a missing upload the very same answer", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    const [row] = await issue("service", ids.parentA, id);
    const stranger = await checkFails(ids.parentB, row!.upload_id);
    const missing = await checkFails(ids.parentB, "99999999-9999-4999-8999-999999999999");
    expect(stranger).toContain("not_found");
    expect(stranger).toBe(missing);
  });

  it("refuses a used, superseded, rejected or expired authorization", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    const [first] = await issue("service", ids.parentA, id);
    const [second] = await issue("service", ids.parentA, id);
    expect(await checkFails(ids.parentA, first!.upload_id)).toContain("upload_not_current"); // superseded
    await attach(ids.parentA, second!.upload_id);
    expect(await checkFails(ids.parentA, second!.upload_id)).toContain("upload_not_current"); // already used
    const [third] = await issue("service", ids.parentA, id);
    await q(db(), "service", "select public.reject_video_upload($1,$2,'rejected')", [ids.parentA, third!.upload_id]);
    expect(await checkFails(ids.parentA, third!.upload_id)).toContain("upload_not_current"); // rejected
    const [fourth] = await issue("service", ids.parentA, id);
    await actAs(db(), "superuser");
    await db().query("update public.video_uploads set expires_at = now() - interval '11 minutes' where id = $1", [fourth!.upload_id]);
    expect(await checkFails(ids.parentA, fourth!.upload_id)).toContain("upload_expired");
  });

  it("refuses when the window has closed or the entry was withdrawn", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    const [row] = await issue("service", ids.parentA, id);
    await closeWindow();
    expect(await checkFails(ids.parentA, row!.upload_id)).toContain("submissions_closed");
    await actAs(db(), "superuser");
    await db().exec("update public.event_settings set submissions_close_at = now() + interval '1 day'");
    await db().query("update public.submissions set status = 'withdrawn' where id = $1", [id]);
    expect(await checkFails(ids.parentA, row!.upload_id)).toContain("submission_locked");
  });
});

describe("attaching a verified upload", () => {
  it("moves a draft to uploaded and records the verified size", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    const [row] = await issue("service", ids.parentA, id);
    await attach(ids.parentA, row!.upload_id);
    expect(await sub(id)).toEqual({ status: "uploaded", video_key: row!.upload_id });
    const [u] = await q<{ status: string; verified_bytes: number; etag: string }>(db(), "superuser", "select status, verified_bytes, etag from public.video_uploads where id = $1", [row!.upload_id]);
    expect(u).toEqual({ status: "verified", verified_bytes: 20 * MB, etag: "etag-1" });
  });

  it("is single use: the same authorization cannot be attached twice", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    const [row] = await issue("service", ids.parentA, id);
    await attach(ids.parentA, row!.upload_id);
    expect((await fails(db(), "service", "select public.attach_video_upload($1,$2,20971520,'video/mp4','x')", [ids.parentA, row!.upload_id])).message).toContain("upload_not_current");
  });

  it("refuses another parent, a size that differs from the declaration, and an expired authorization", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    const [row] = await issue("service", ids.parentA, id);
    expect((await fails(db(), "service", "select public.attach_video_upload($1,$2,20971520,'video/mp4','x')", [ids.parentB, row!.upload_id])).message).toContain("not_found");
    expect((await fails(db(), "service", "select public.attach_video_upload($1,$2,20971521,'video/mp4','x')", [ids.parentA, row!.upload_id])).message).toContain("size_mismatch");
    expect((await fails(db(), "service", "select public.attach_video_upload($1,$2,20971520,'video/webm','x')", [ids.parentA, row!.upload_id])).message).toContain("type_mismatch");
    await actAs(db(), "superuser");
    await db().query("update public.video_uploads set expires_at = now() - interval '11 minutes' where id = $1", [row!.upload_id]);
    expect((await fails(db(), "service", "select public.attach_video_upload($1,$2,20971520,'video/mp4','x')", [ids.parentA, row!.upload_id])).message).toContain("upload_expired");
    expect((await sub(id)).video_key).toBeNull();
  });

  it("an older authorization cannot be attached after a newer one was issued", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    const [first] = await issue("service", ids.parentA, id);
    await issue("service", ids.parentA, id);
    expect((await fails(db(), "service", "select public.attach_video_upload($1,$2,20971520,'video/mp4','x')", [ids.parentA, first!.upload_id])).message).toContain("upload_not_current");
  });

  it("a replacement keeps the entry uploaded, points at the new video, and queues the old one for deletion", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    const [a] = await issue("service", ids.parentA, id);
    await attach(ids.parentA, a!.upload_id);
    const [b] = await issue("service", ids.parentA, id, "video/webm", 30 * MB);
    const [res] = await attach(ids.parentA, b!.upload_id, 30 * MB, "etag-2", "video/webm");
    expect(res!.attach_video_upload).toBe(a!.upload_id);
    expect(await sub(id)).toEqual({ status: "uploaded", video_key: b!.upload_id });
    expect((await upload(a!.upload_id)).status).toBe("superseded");
    const stale = await q<{ stale_video_uploads: string }>(db(), "service", "select * from public.stale_video_uploads(10)");
    expect(stale.map((r) => r.stale_video_uploads)).toContain(a!.upload_id);
    expect(stale.map((r) => r.stale_video_uploads)).not.toContain(b!.upload_id);
  });

  it("will not attach once the window closed or the entry was withdrawn", async () => {
    const closed = await insertDraft(db(), { owner: ids.parentA, childName: "Child One" });
    const [c] = await issue("service", ids.parentA, closed);
    await closeWindow();
    expect((await fails(db(), "service", "select public.attach_video_upload($1,$2,20971520,'video/mp4','x')", [ids.parentA, c!.upload_id])).message).toContain("submissions_closed");

    await actAs(db(), "superuser");
    await db().exec("update public.event_settings set submissions_close_at = now() + interval '1 day'");
    await db().query("update public.submissions set status = 'withdrawn' where id = $1", [closed]);
    expect((await fails(db(), "service", "select public.attach_video_upload($1,$2,20971520,'video/mp4','x')", [ids.parentA, c!.upload_id])).message).toContain("submission_locked");
  });

  it("never lets the entry become finalized: attach only reaches 'uploaded'", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    const [row] = await issue("service", ids.parentA, id);
    await attach(ids.parentA, row!.upload_id);
    expect((await sub(id)).status).toBe("uploaded");
  });
});

describe("rejecting and cleaning up", () => {
  it("a rejected or abandoned authorization is dead and is queued for deletion", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    const [row] = await issue("service", ids.parentA, id);
    await q(db(), "service", "select public.reject_video_upload($1,$2,'rejected')", [ids.parentA, row!.upload_id]);
    expect((await upload(row!.upload_id)).status).toBe("rejected");
    expect((await fails(db(), "service", "select public.attach_video_upload($1,$2,20971520,'video/mp4','x')", [ids.parentA, row!.upload_id])).message).toContain("upload_not_current");
    expect((await fails(db(), "service", "select public.reject_video_upload($1,$2,'verified')", [ids.parentA, row!.upload_id])).message).toContain("invalid_status");
    const stale = await q<{ stale_video_uploads: string }>(db(), "service", "select * from public.stale_video_uploads(10)");
    expect(stale.map((r) => r.stale_video_uploads)).toContain(row!.upload_id);
    await q(db(), "service", "select public.mark_video_upload_deleted($1)", [row!.upload_id]);
    expect((await upload(row!.upload_id)).status).toBe("deleted");
  });

  it("an authorization nobody used becomes abandoned an hour after it expired, but a verified video is never listed", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    const [old] = await issue("service", ids.parentA, id);
    await actAs(db(), "superuser");
    await db().query("update public.video_uploads set expires_at = now() - interval '61 minutes' where id = $1", [old!.upload_id]);
    const other = await insertDraft(db(), { owner: ids.parentB, childName: "Child Two" });
    const [kept] = await issue("service", ids.parentB, other);
    await attach(ids.parentB, kept!.upload_id);
    const stale = (await q<{ stale_video_uploads: string }>(db(), "service", "select * from public.stale_video_uploads(10)")).map((r) => r.stale_video_uploads);
    expect(stale).toContain(old!.upload_id);
    expect(stale).not.toContain(kept!.upload_id);
    expect((await upload(old!.upload_id)).status).toBe("abandoned");
  });
});
