import { describe, expect, it } from "vitest";
import { actAs, fails, ids, PG, q, setupDb } from "./helpers";

// The revised live suite (supabase/live-tests/auth-sessions.live.test.ts) reaches "finalized" through service-role RPCs with
// NAMED arguments, the way PostgREST passes a JSON body. This replays exactly those calls on the real migrations, so a wrong
// parameter name or order in the live fixtures is caught here, offline, before anything hosted is touched.

const db = setupDb();
const UPLOAD = { bytes: 20 * 1024 * 1024, type: "video/mp4" };
const etag = '"live-fixture"';

async function register(owner: string, child: string, mobile: string, event: number): Promise<string> {
  await actAs(db(), "superuser");
  await db().exec("update public.event_settings set current_consent_version = 'live-test'");
  const r = await db().query<{ id: string }>(
    `insert into public.submissions (owner_id, event_id, child_name, child_age, parent_name, parent_email, parent_mobile, consent_version)
     values ($1,$2,$3,9,'Parent','p@example.test',$4,'live-test') returning id`,
    [owner, event, child, mobile],
  );
  return r.rows[0]!.id;
}
async function verified(owner: string, id: string): Promise<string> {
  const issued = await q<{ upload_id: string }>(db(), "service", "select * from public.issue_video_upload(p_owner => $1, p_submission => $2, p_content_type => $3, p_bytes => $4)", [owner, id, UPLOAD.type, UPLOAD.bytes]);
  const upload = issued[0]!.upload_id;
  await q(db(), "service", "select public.attach_video_upload(p_owner => $1, p_upload => $2, p_bytes => $3, p_content_type => $4, p_etag => $5)", [owner, upload, UPLOAD.bytes, UPLOAD.type, etag]);
  return upload;
}
const finalizeNamed = (owner: string, id: string, upload: string, over: { etag?: string } = {}) =>
  q<{ finalize_verified_submission: string }>(db(), "service", "select public.finalize_verified_submission(p_owner => $1, p_submission => $2, p_upload => $3, p_bytes => $4, p_content_type => $5, p_etag => $6)", [owner, id, upload, UPLOAD.bytes, UPLOAD.type, over.etag ?? etag]);

describe("the live fixtures' own call sequence", () => {
  it("issue, attach, check and finalize with named arguments work end to end and leave the entry finalized", async () => {
    const id = await register(ids.parentA, "Fixture", "9876500001", 3);
    const upload = await verified(ids.parentA, id);
    const check = await q<{ already: boolean }>(db(), "service", "select * from public.check_finalize(p_owner => $1, p_submission => $2)", [ids.parentA, id]);
    expect(check[0]!.already).toBe(false);
    expect((await finalizeNamed(ids.parentA, id, upload))[0]!.finalize_verified_submission).toBe("finalized");
    expect((await finalizeNamed(ids.parentA, id, upload))[0]!.finalize_verified_submission).toBe("already_finalized");
    const rows = await q<{ status: string }>(db(), "superuser", "select status from public.submissions where id = $1", [id]);
    expect(rows[0]!.status).toBe("finalized");
  });

  it("the refusals the live tests assert: a changed object, another parent, a duplicate child, and every non-service caller", async () => {
    const id = await register(ids.parentB, "Twin Child", "9876500002", 5);
    const upload = await verified(ids.parentB, id);
    expect((await fails(db(), "service", "select public.finalize_verified_submission(p_owner => $1, p_submission => $2, p_upload => $3, p_bytes => $4, p_content_type => $5, p_etag => $6)", [ids.parentB, id, upload, UPLOAD.bytes, UPLOAD.type, '"replaced"'])).message).toContain("video_changed");
    expect((await fails(db(), "service", "select * from public.check_finalize(p_owner => $1, p_submission => $2)", [ids.parentA, id])).message).toContain("not_found");

    const first = await register(ids.parentA, "Twin Child", "9876500002", 3);
    await finalizeNamed(ids.parentA, first, await verified(ids.parentA, first));
    const dup = await fails(db(), "service", "select public.finalize_verified_submission(p_owner => $1, p_submission => $2, p_upload => $3, p_bytes => $4, p_content_type => $5, p_etag => $6)", [ids.parentB, id, upload, UPLOAD.bytes, UPLOAD.type, etag]);
    expect(dup.code).toBe(PG.uniqueViolation);
    expect(dup.message).toBe("duplicate_entry");

    for (const who of ["anon", "parentA", "parentB", "judge1", "admin"] as const) {
      expect((await fails(db(), who, "select * from public.check_finalize(p_owner => $1, p_submission => $2)", [ids.parentB, id])).code, who).toBe(PG.insufficientPrivilege);
    }
    expect((await fails(db(), "parentB", "select public.finalize_submission($1)", [id])).code).toBe("42883");
  });
});
