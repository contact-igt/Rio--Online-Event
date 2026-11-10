import { describe, expect, it } from "vitest";
import { actAs, fails, finalize, ids, insertDraft, PG, q, setupDb, uploadVerified } from "./helpers";

const db = setupDb();

const INSERT_SQL = `insert into public.submissions
  (owner_id, event_id, child_name, child_age, parent_name, parent_email, parent_mobile, consent_version)
  values ($1, $2, $3, $4, $5, $6, $7, $8)`;
const ROW = [ids.parentA, 2, "Asha Test", 6, "Parent Test", "parent@example.test", "9876543210", "v1"];
const row = (over: Partial<Record<number, unknown>>) => ROW.map((v, i) => (i in over ? over[i] : v));

describe("registration constraints", () => {
  it("accepts ages 3 to 12 only", async () => {
    for (const age of [2, 13, 0, -1]) {
      // the band trigger fires before the CHECK constraint, so either error proves the age was refused
      const e = await fails(db(), "superuser", INSERT_SQL, row({ 3: age, 1: 5 }));
      expect([PG.checkViolation, PG.raiseException]).toContain(e.code);
    }
    // the column constraint itself, without the trigger's help
    await actAs(db(), "superuser");
    await db().exec("alter table public.submissions disable trigger submissions_guard");
    for (const age of [2, 13]) {
      expect((await fails(db(), "superuser", INSERT_SQL, row({ 3: age }))).code).toBe(PG.checkViolation);
    }
    await db().exec("alter table public.submissions enable trigger submissions_guard");
    for (const age of [3, 12]) {
      await actAs(db(), "superuser");
      await db().query(INSERT_SQL, row({ 3: age, 1: age === 3 ? 1 : 3, 5: `a${age}@example.test`, 6: `98765432${age < 10 ? "0" + age : age}` }));
    }
  });

  it("enforces each competition's age band", async () => {
    const bands: Record<number, [number, number]> = { 1: [3, 5], 2: [5, 8], 3: [6, 12], 4: [8, 12], 5: [5, 12], 6: [6, 12] };
    for (const [event, [min, max]] of Object.entries(bands)) {
      for (let age = 3; age <= 12; age++) {
        const inside = age >= min && age <= max;
        if (inside) {
          await actAs(db(), "superuser");
          await db().query("savepoint ok");
          await db().query(INSERT_SQL, row({ 1: Number(event), 3: age }));
          await db().query("rollback to savepoint ok");
        } else {
          const e = await fails(db(), "superuser", INSERT_SQL, row({ 1: Number(event), 3: age }));
          expect(e.message).toContain("age_not_eligible");
        }
      }
    }
  });

  it("re-checks the band when age or event is edited", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA, event: 4, age: 9 });
    expect((await fails(db(), "superuser", "update public.submissions set child_age = 7 where id = $1", [id])).message).toContain("age_not_eligible");
    expect((await fails(db(), "superuser", "update public.submissions set event_id = 1 where id = $1", [id])).message).toContain("age_not_eligible");
  });

  it("validates mobile numbers (10-digit Indian mobile, optional 91 or 0 prefix)", async () => {
    for (const bad of ["12345", "5876543210", "98765", "+1 415 555 0100", "98765432101234"]) {
      expect((await fails(db(), "superuser", INSERT_SQL, row({ 6: bad }))).code).toBe(PG.checkViolation);
    }
    for (const good of ["9876543210", "+919876543210", "09876543210", "+91 98765-43210"]) {
      await actAs(db(), "superuser");
      await db().query("savepoint ok");
      await db().query(INSERT_SQL, row({ 6: good }));
      await db().query("rollback to savepoint ok");
    }
  });

  it("requires a lower-case, well-formed email", async () => {
    for (const bad of ["Parent@Example.test", "no-at-sign", "a@b", "a b@example.test"]) {
      expect((await fails(db(), "superuser", INSERT_SQL, row({ 5: bad }))).code).toBe(PG.checkViolation);
    }
  });

  it("derives normalized duplicate keys (mobile last 10 digits, name without case/space/punctuation)", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA, childName: "  Ravi   Kumar. ", mobile: "+91 98765-43210" });
    const [r] = await q<{ parent_phone_norm: string; child_name_norm: string }>(db(), "superuser", "select parent_phone_norm, child_name_norm from public.submissions where id = $1", [id]);
    expect(r).toEqual({ parent_phone_norm: "9876543210", child_name_norm: "ravikumar" });
    const tamil = await insertDraft(db(), { owner: ids.parentA, childName: "சிவா  குமார்", mobile: "9876543211", email: "t@example.test" });
    const [t] = await q<{ child_name_norm: string }>(db(), "superuser", "select child_name_norm from public.submissions where id = $1", [tamil]);
    expect(t!.child_name_norm).toBe("சிவாகுமார்");
  });

  it("records declared age as of 2026-11-14 and refuses any other date", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    const [r] = await q<{ d: string }>(db(), "superuser", "select to_char(age_as_of, 'YYYY-MM-DD') as d from public.submissions where id = $1", [id]);
    expect(r!.d).toBe("2026-11-14");
    expect((await fails(db(), "superuser", "update public.submissions set age_as_of = '2026-11-15' where id = $1", [id])).message).toContain("immutable_column");
    const wrongDate = INSERT_SQL.replace("consent_version)", "consent_version, age_as_of)").replace("$8)", "$8, '2026-11-15')");
    expect((await fails(db(), "superuser", wrongDate, ROW)).code).toBe(PG.checkViolation);
  });
});

describe("consent and submission window", () => {
  it("rejects a consent version that is not the current one", async () => {
    expect((await fails(db(), "superuser", INSERT_SQL, row({ 7: "v0-old" }))).message).toContain("consent_version_mismatch");
  });

  it("refuses registration until an admin has set a consent version", async () => {
    await actAs(db(), "superuser");
    await db().exec("update public.event_settings set current_consent_version = null");
    expect((await fails(db(), "superuser", INSERT_SQL, ROW)).message).toContain("consent_version_mismatch");
  });

  it("stamps consent_at on the server and refuses a client-supplied value", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    const [r] = await q<{ recent: boolean }>(db(), "superuser", "select consent_at > now() - interval '1 minute' as recent from public.submissions where id = $1", [id]);
    expect(r!.recent).toBe(true);
    const e = await fails(db(), "parentA", "insert into public.submissions (event_id, child_name, child_age, parent_name, parent_email, parent_mobile, consent_version, consent_at) values (2,'A',6,'P','p@example.test','9876543210','v1','2020-01-01')");
    expect(e.code).toBe(PG.insufficientPrivilege);
  });

  it("is closed outside the window and before it is configured", async () => {
    await actAs(db(), "superuser");
    await db().exec("update public.event_settings set submissions_close_at = now() - interval '1 hour', submissions_open_at = now() - interval '2 days'");
    expect((await fails(db(), "superuser", INSERT_SQL, ROW)).message).toContain("submissions_closed");
    await db().exec("update public.event_settings set submissions_open_at = now() + interval '1 day', submissions_close_at = now() + interval '2 days'");
    expect((await fails(db(), "superuser", INSERT_SQL, ROW)).message).toContain("submissions_closed");
    await db().exec("update public.event_settings set submissions_open_at = null, submissions_close_at = null");
    expect((await fails(db(), "superuser", INSERT_SQL, ROW)).message).toContain("submissions_closed");
  });
});

describe("submission status transitions", () => {
  it("cannot jump from draft to finalized", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    expect((await fails(db(), "superuser", "update public.submissions set status = 'finalized' where id = $1", [id])).message).toContain("invalid_status_transition");
  });

  it("needs a video reference to be uploaded, and a draft cannot hold one", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    expect((await fails(db(), "superuser", "update public.submissions set status = 'uploaded' where id = $1", [id])).code).toBe(PG.checkViolation);
    expect((await fails(db(), "superuser", "update public.submissions set video_key = gen_random_uuid() where id = $1", [id])).code).toBe(PG.checkViolation);
  });

  it("allows replacing the video while uploaded, but not going back to draft", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    await actAs(db(), "superuser");
    await db().query("update public.submissions set status='uploaded', video_key=gen_random_uuid() where id=$1", [id]);
    await db().query("update public.submissions set video_key=gen_random_uuid() where id=$1", [id]);
    expect((await fails(db(), "superuser", "update public.submissions set status='draft', video_key=null where id=$1", [id])).message).toContain("invalid_status_transition");
  });

  it("locks a finalized entry except for withdrawal", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    await finalize(db(), id);
    for (const sql of [
      "update public.submissions set child_name = 'Other' where id = $1",
      "update public.submissions set parent_mobile = '9000000000' where id = $1",
      "update public.submissions set event_id = 3 where id = $1",
      "update public.submissions set video_key = gen_random_uuid() where id = $1",
    ]) {
      expect((await fails(db(), "superuser", sql, [id])).message).toContain("submission_locked");
    }
    expect((await fails(db(), "superuser", "update public.submissions set status = 'uploaded' where id = $1", [id])).message).toContain("invalid_status_transition");
    await actAs(db(), "superuser");
    await db().query("update public.submissions set status = 'withdrawn' where id = $1", [id]);
  });

  it("treats withdrawn as final", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    await actAs(db(), "superuser");
    await db().query("update public.submissions set status = 'withdrawn' where id = $1", [id]);
    expect((await fails(db(), "superuser", "update public.submissions set status = 'draft' where id = $1", [id])).message).toContain("submission_locked");
    expect((await fails(db(), "superuser", "update public.submissions set child_name = 'X' where id = $1", [id])).message).toContain("submission_locked");
  });

  it("never lets identity and consent columns change", async () => {
    const id = await insertDraft(db(), { owner: ids.parentA });
    for (const sql of [
      "update public.submissions set entry_code = 'RIO-AAAAA-AAAAA' where id = $1",
      `update public.submissions set owner_id = '${ids.parentB}' where id = $1`,
      "update public.submissions set consent_version = 'v2' where id = $1",
      "update public.submissions set consent_at = now() - interval '1 year' where id = $1",
    ]) {
      expect((await fails(db(), "superuser", sql, [id])).message).toContain("immutable_column");
    }
  });

  it("keeps video references unique", async () => {
    const a = await insertDraft(db(), { owner: ids.parentA });
    const b = await insertDraft(db(), { owner: ids.parentB, childName: "Other Child", mobile: "9123456780", email: "b@example.test" });
    await actAs(db(), "superuser");
    await db().query("update public.submissions set status='uploaded', video_key='00000000-0000-4000-8000-000000000001' where id=$1", [a]);
    expect((await fails(db(), "superuser", "update public.submissions set status='uploaded', video_key='00000000-0000-4000-8000-000000000001' where id=$1", [b])).code).toBe(PG.uniqueViolation);
  });
});

describe("one finalized submission per child", () => {
  it("blocks a second finalized entry for the same mobile + child name, however it is typed", async () => {
    const first = await insertDraft(db(), { owner: ids.parentA, event: 2, childName: "Ravi Kumar", mobile: "+91 98765 43210" });
    const second = await insertDraft(db(), { owner: ids.parentB, event: 5, childName: "  ravi  KUMAR. ", mobile: "09876543210", email: "other@example.test" });
    await finalize(db(), first);
    await actAs(db(), "superuser");
    await db().query("update public.submissions set status='uploaded', video_key=gen_random_uuid() where id=$1", [second]);
    const e = await fails(db(), "superuser", "update public.submissions set status='finalized' where id=$1", [second]);
    expect(e.code).toBe(PG.uniqueViolation);
  });

  it("across a different parent account, through the server-only finalizer, with a generic error that reveals nothing", async () => {
    const first = await insertDraft(db(), { owner: ids.parentA, childName: "Ravi Kumar", mobile: "9876543210" });
    const second = await insertDraft(db(), { owner: ids.parentB, event: 5, childName: "Ravi Kumar", mobile: "9876543210", email: "other@example.test" });
    await finalize(db(), first);
    const v = await uploadVerified(db(), ids.parentB, second);
    const e = await fails(db(), "service", "select public.finalize_verified_submission($1,$2,$3,$4,$5,$6)", [ids.parentB, second, v.upload, v.bytes, v.type, v.etag]);
    expect(e.code).toBe(PG.uniqueViolation);
    expect(e.message).toBe("duplicate_entry");
  });

  it("allows siblings (same mobile, different name) and namesakes (same name, different mobile)", async () => {
    const a = await insertDraft(db(), { owner: ids.parentA, childName: "Asha", mobile: "9876543210" });
    const b = await insertDraft(db(), { owner: ids.parentA, childName: "Bala", mobile: "9876543210", email: "a2@example.test" });
    const c = await insertDraft(db(), { owner: ids.parentB, childName: "Asha", mobile: "9123456780", email: "b@example.test" });
    for (const id of [a, b, c]) await finalize(db(), id);
  });

  it("allows the same child to hold drafts in several events, but only one can finalize", async () => {
    const a = await insertDraft(db(), { owner: ids.parentA, event: 2, childName: "Asha", age: 6 });
    const b = await insertDraft(db(), { owner: ids.parentA, event: 5, childName: "Asha", age: 6 });
    await finalize(db(), a);
    await actAs(db(), "superuser");
    await db().query("update public.submissions set status='uploaded', video_key=gen_random_uuid() where id=$1", [b]);
    expect((await fails(db(), "superuser", "update public.submissions set status='finalized' where id=$1", [b])).code).toBe(PG.uniqueViolation);
  });

  it("frees the slot when the finalized entry is withdrawn", async () => {
    const a = await insertDraft(db(), { owner: ids.parentA, event: 2, childName: "Asha", age: 6 });
    const b = await insertDraft(db(), { owner: ids.parentA, event: 5, childName: "Asha", age: 6 });
    await finalize(db(), a);
    await actAs(db(), "superuser");
    await db().query("update public.submissions set status='withdrawn' where id=$1", [a]);
    await finalize(db(), b);
  });
});

describe("scores", () => {
  async function scoreFixture() {
    const sub = await insertDraft(db(), { owner: ids.parentA });
    await finalize(db(), sub);
    await actAs(db(), "superuser");
    await db().query("insert into public.judge_assignments (judge_id, submission_id) values ($1, $2), ($3, $2)", [ids.judge1, sub, ids.judge2]);
    return sub;
  }
  const INSERT_SCORE = "insert into public.scores (judge_id, submission_id, marks, status) values ($1, $2, $3, $4)";

  it("keeps marks between 0 and 100", async () => {
    const sub = await scoreFixture();
    for (const bad of [-0.01, 100.01, 150, -5]) {
      expect((await fails(db(), "superuser", INSERT_SCORE, [ids.judge1, sub, bad, "draft"])).code).toBe(PG.checkViolation);
    }
    await actAs(db(), "superuser");
    for (const [judge, marks] of [[ids.judge1, 0], [ids.judge2, 100]] as const) {
      await db().query(INSERT_SCORE, [judge, sub, marks, "draft"]);
    }
  });

  it("needs marks before a score can be final", async () => {
    const sub = await scoreFixture();
    expect((await fails(db(), "superuser", "insert into public.scores (judge_id, submission_id, status) values ($1,$2,'final')", [ids.judge1, sub])).code).toBe(PG.checkViolation);
  });

  it("allows one row per judge per submission", async () => {
    const sub = await scoreFixture();
    await actAs(db(), "superuser");
    await db().query(INSERT_SCORE, [ids.judge1, sub, 50, "draft"]);
    expect((await fails(db(), "superuser", INSERT_SCORE, [ids.judge1, sub, 60, "draft"])).code).toBe(PG.uniqueViolation);
    await db().query(INSERT_SCORE, [ids.judge2, sub, 60, "draft"]); // a different judge may score the same entry
  });

  it("locks a final score; only an administrator can reopen it", async () => {
    const sub = await scoreFixture();
    await actAs(db(), "superuser");
    const { rows } = await db().query<{ id: string }>("insert into public.scores (judge_id, submission_id, marks, status) values ($1,$2,80,'final') returning id", [ids.judge1, sub]);
    const id = rows[0]!.id;
    expect((await fails(db(), "superuser", "update public.scores set marks = 99 where id = $1", [id])).message).toContain("score_locked");
    expect((await fails(db(), "superuser", "update public.scores set status = 'draft' where id = $1", [id])).message).toContain("score_locked");
    await actAs(db(), "admin");
    await db().query("select public.unlock_score($1)", [id]);
    const [r] = await q<{ status: string; finalized_at: string | null }>(db(), "superuser", "select status, finalized_at from public.scores where id = $1", [id]);
    expect(r).toEqual({ status: "draft", finalized_at: null });
  });

  it("cannot score a submission that is not finalized, or assign one", async () => {
    const draft = await insertDraft(db(), { owner: ids.parentA });
    expect((await fails(db(), "superuser", "insert into public.judge_assignments (judge_id, submission_id) values ($1, $2)", [ids.judge1, draft])).message).toContain("submission_not_finalized");
  });
});

describe("roles and settings", () => {
  it("accepts only the roles admin and judge", async () => {
    expect((await fails(db(), "superuser", "insert into public.user_roles (user_id, role) values ($1, 'owner')", [ids.parentA])).code).toBe(PG.checkViolation);
  });

  it("allows a judge profile only for a user who holds the judge role", async () => {
    expect((await fails(db(), "superuser", "insert into public.judge_profiles (user_id, display_name) values ($1, 'Nobody')", [ids.parentA])).code).toBe(PG.foreignKeyViolation);
    expect((await fails(db(), "superuser", "insert into public.judge_profiles (user_id, display_name) values ($1, 'An Admin')", [ids.admin])).code).toBe(PG.foreignKeyViolation);
  });

  it("never removes or demotes the last administrator", async () => {
    await actAs(db(), "superuser");
    await db().query("delete from public.user_roles where user_id = $1", [ids.admin2]); // one admin remains
    expect((await fails(db(), "superuser", "delete from public.user_roles where user_id = $1", [ids.admin])).message).toContain("last_admin");
    expect((await fails(db(), "superuser", "update public.user_roles set role = 'judge' where user_id = $1", [ids.admin])).message).toMatch(/last_admin|violates foreign key/);
  });

  it("refuses to schedule results before 14 November 2026 (IST) or a window that ends before it starts", async () => {
    await actAs(db(), "superuser");
    expect((await fails(db(), "superuser", "update public.event_settings set results_publish_at = '2026-11-13 23:59:00+05:30'")).code).toBe(PG.checkViolation);
    await db().exec("update public.event_settings set results_publish_at = '2026-11-14 00:00:00+05:30'");
    await db().exec("update public.event_settings set results_publish_at = null");
    expect((await fails(db(), "superuser", "update public.event_settings set submissions_close_at = submissions_open_at - interval '1 day'")).code).toBe(PG.checkViolation);
  });

  it("allows exactly one settings row", async () => {
    expect((await fails(db(), "superuser", "insert into public.event_settings (id) values (false)")).code).toBe(PG.checkViolation);
    expect((await fails(db(), "superuser", "insert into public.event_settings (id) values (true)")).code).toBe(PG.uniqueViolation);
  });
});
