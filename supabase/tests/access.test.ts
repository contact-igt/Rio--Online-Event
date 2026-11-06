import { describe, expect, it } from "vitest";
import { actAs, fails, finalize, ids, insertDraft, PG, q, setupDb, type Who } from "./helpers";

const db = setupDb();

// Distinctive personal data, so any leak is easy to detect by searching for these needles.
const PII = {
  childName: "Zorathustra Quillfeather",
  parentName: "Ottoline Brambleworth",
  email: "ottoline.brambleworth@example.test",
  mobile: "+91 97531 86420",
};
// Full-length needles only: short digit runs could appear by chance inside random uuids.
const NEEDLES = ["Zorathustra", "Quillfeather", "Ottoline", "Brambleworth", "9753186420", "97531 86420"];

async function piiEntry(owner: string = ids.parentA): Promise<string> {
  const id = await insertDraft(db(), { owner, event: 3, age: 9, childName: PII.childName, parentName: PII.parentName, email: PII.email, mobile: PII.mobile });
  await finalize(db(), id);
  return id;
}
async function assign(judge: string, sub: string) {
  await actAs(db(), "superuser");
  await db().query("insert into public.judge_assignments (judge_id, submission_id) values ($1,$2)", [judge, sub]);
}
const count = async (who: Who, rel: string) => Number((await q<{ n: string }>(db(), who, `select count(*) as n from ${rel}`))[0]!.n);

const PII_TABLES = ["submissions", "scores", "judge_assignments", "winners", "audit_log", "judge_profiles", "user_roles"];

describe("anonymous visitors", () => {
  it("cannot touch any table that holds personal or internal data", async () => {
    await piiEntry();
    for (const rel of [...PII_TABLES, "judge_entries"]) {
      expect((await fails(db(), "anon", `select * from public.${rel}`)).code, rel).toBe(PG.insufficientPrivilege);
    }
    expect((await fails(db(), "anon", "select * from auth.users")).code).toBe(PG.insufficientPrivilege);
  });

  it("cannot write or call any function", async () => {
    expect((await fails(db(), "anon", "insert into public.submissions (event_id, child_name, child_age, parent_name, parent_email, parent_mobile, consent_version) values (2,'A',6,'P','p@example.test','9876543210','v1')")).code).toBe(PG.insufficientPrivilege);
    for (const fn of ["withdraw_submission", "unlock_score"]) {
      expect((await fails(db(), "anon", `select public.${fn}(gen_random_uuid())`)).code, fn).toBe(PG.insufficientPrivilege);
    }
    expect((await fails(db(), "anon", "select public.check_finalize(gen_random_uuid(), gen_random_uuid())")).code).toBe(PG.insufficientPrivilege); // M4B: server-only
    expect((await fails(db(), "anon", "select private.is_admin()")).code).toBe(PG.insufficientPrivilege);
  });

  it("can read the public event list, settings and (unpublished) winners view", async () => {
    expect(await count("anon", "public.events")).toBe(6);
    expect(await count("anon", "public.event_settings")).toBe(1);
    expect(await count("anon", "public.published_winners")).toBe(0);
  });
});

describe("parents", () => {
  const INSERT_OWN = "insert into public.submissions (event_id, child_name, child_age, parent_name, parent_email, parent_mobile, consent_version) values (2,'Asha Test',6,'Parent Test','p@example.test','9876543210','v1') returning id, owner_id, status";

  it("can register a child; the owner is the signed-in user and the status is draft", async () => {
    const [r] = await q<{ owner_id: string; status: string }>(db(), "parentA", INSERT_OWN);
    expect(r).toMatchObject({ owner_id: ids.parentA, status: "draft" });
  });

  it("cannot register on behalf of another user or set protected columns", async () => {
    const base = "(event_id, child_name, child_age, parent_name, parent_email, parent_mobile, consent_version";
    const vals = "2,'A',6,'P','p@example.test','9876543210','v1'";
    for (const [col, val] of [["owner_id", `'${ids.parentB}'`], ["status", "'finalized'"], ["video_key", "gen_random_uuid()"], ["entry_code", "'RIO-FAKE1-FAKE2'"], ["consent_at", "now()"]]) {
      const e = await fails(db(), "parentA", `insert into public.submissions ${base}, ${col}) values (${vals}, ${val})`);
      expect(e.code, col).toBe(PG.insufficientPrivilege);
    }
  });

  it("see only their own submissions and cannot change another parent's", async () => {
    const a = await insertDraft(db(), { owner: ids.parentA, childName: "Asha" });
    const b = await insertDraft(db(), { owner: ids.parentB, childName: "Bala", mobile: "9123456780", email: "b@example.test" });
    expect((await q<{ id: string }>(db(), "parentA", "select id from public.submissions")).map((r) => r.id)).toEqual([a]);
    expect((await q<{ id: string }>(db(), "parentB", "select id from public.submissions")).map((r) => r.id)).toEqual([b]);
    const upd = await q(db(), "parentA", "update public.submissions set child_name = 'Hacked' where id = $1 returning id", [b]);
    expect(upd).toEqual([]);
    const [still] = await q<{ child_name: string }>(db(), "superuser", "select child_name from public.submissions where id = $1", [b]);
    expect(still!.child_name).toBe("Bala");
  });

  it("can edit their draft but not status, video_key, or owner; cannot delete", async () => {
    const a = await insertDraft(db(), { owner: ids.parentA });
    expect(await q(db(), "parentA", "update public.submissions set child_name = 'Asha Edited' where id = $1 returning id", [a])).toHaveLength(1);
    for (const col of ["status = 'finalized'", "video_key = gen_random_uuid()", `owner_id = '${ids.parentB}'`, "consent_at = now()", "entry_code = 'X'"]) {
      expect((await fails(db(), "parentA", `update public.submissions set ${col} where id = $1`, [a])).code, col).toBe(PG.insufficientPrivilege);
    }
    expect((await fails(db(), "parentA", "delete from public.submissions where id = $1", [a])).code).toBe(PG.insufficientPrivilege);
  });

  it("cannot edit a finalized entry", async () => {
    const a = await insertDraft(db(), { owner: ids.parentA });
    await finalize(db(), a);
    expect(await q(db(), "parentA", "update public.submissions set child_name = 'Changed' where id = $1 returning id", [a])).toEqual([]);
  });

  it("withdraw only their own entries, before finalizing; finalizing is server-only (M4B) and irreversible for parents", async () => {
    const draft = await insertDraft(db(), { owner: ids.parentA, childName: "D" });
    const up = await insertDraft(db(), { owner: ids.parentA, childName: "U", email: "u@example.test" });
    await finalize(db(), up); // by the server path in production; the tests use the trigger-checked superuser path
    const [r] = await q<{ status: string }>(db(), "parentA", "select status from public.submissions where id = $1", [up]);
    expect(r!.status).toBe("finalized");
    // the old parent-callable finalizer is gone
    expect((await fails(db(), "parentA", "select public.finalize_submission($1)", [draft])).code).toBe("42883");

    expect((await fails(db(), "parentA", "select public.withdraw_submission($1)", [up])).message).toBe("not_found"); // finalizing is irreversible for parents
    await q(db(), "parentA", "select public.withdraw_submission($1)", [draft]);
    expect((await fails(db(), "parentB", "select public.withdraw_submission($1)", [draft])).message).toBe("not_found");
  });

  it("cannot read judging, assignment, winner, audit or role data, and cannot make themselves staff", async () => {
    const sub = await piiEntry();
    await assign(ids.judge1, sub);
    await actAs(db(), "judge1");
    await db().query("insert into public.scores (submission_id, marks, status) values ($1, 70, 'final')", [sub]);
    for (const rel of ["scores", "judge_assignments", "winners", "audit_log", "judge_profiles", "user_roles", "judge_entries"]) {
      expect(await count("parentA", `public.${rel}`), rel).toBe(0);
    }
    expect((await fails(db(), "parentA", "insert into public.user_roles (user_id, role) values ($1, 'admin')", [ids.parentA])).code).toBe(PG.insufficientPrivilege);
    expect((await fails(db(), "parentA", "select public.unlock_score(gen_random_uuid())")).message).toBe("forbidden");
    expect((await fails(db(), "parentA", "select * from auth.users")).code).toBe(PG.insufficientPrivilege);
    expect(await q(db(), "parentA", "update public.event_settings set current_consent_version = 'evil' returning id")).toEqual([]);
  });
});

describe("accounts without a role (unauthorized users)", () => {
  it("see public data only", async () => {
    await piiEntry();
    for (const rel of [...PII_TABLES, "judge_entries"]) expect(await count("stranger", `public.${rel}`), rel).toBe(0);
    expect(await count("stranger", "public.events")).toBe(6);
  });

  it("cannot assign roles, create judge profiles, or assign entries to themselves", async () => {
    const sub = await piiEntry();
    expect((await fails(db(), "stranger", "insert into public.user_roles (user_id, role) values ($1, 'judge')", [ids.stranger])).code).toBe(PG.insufficientPrivilege);
    expect((await fails(db(), "stranger", "insert into public.judge_profiles (user_id, display_name) values ($1, 'x')", [ids.stranger])).code).toBe(PG.insufficientPrivilege);
    expect((await fails(db(), "stranger", "insert into public.judge_assignments (judge_id, submission_id) values ($1, $2)", [ids.stranger, sub])).code).toBe(PG.insufficientPrivilege);
  });
});

describe("judges and personal data", () => {
  it("get zero rows from submissions, even with filters, counts and joins", async () => {
    const sub = await piiEntry();
    await assign(ids.judge1, sub);
    expect(await count("judge1", "public.submissions")).toBe(0);
    expect(await q(db(), "judge1", "select * from public.submissions where id = $1", [sub])).toEqual([]);
    expect(await q(db(), "judge1", "select s.* from public.scores sc join public.submissions s on s.id = sc.submission_id")).toEqual([]);
    expect(await q(db(), "judge1", "select s.parent_email from public.judge_assignments a join public.submissions s on s.id = a.submission_id")).toEqual([]);
    expect(await q(db(), "judge1", "select * from public.submissions where parent_phone_norm = '9753186420'")).toEqual([]);
  });

  it("cannot write submissions, register children, or change their own role", async () => {
    const sub = await piiEntry();
    await assign(ids.judge1, sub);
    expect(await q(db(), "judge1", "update public.submissions set child_name = 'x' where id = $1 returning id", [sub])).toEqual([]);
    expect((await fails(db(), "judge1", "insert into public.submissions (event_id, child_name, child_age, parent_name, parent_email, parent_mobile, consent_version) values (2,'A',6,'P','p@example.test','9876543210','v1')")).code).toBe(PG.insufficientPrivilege);
    expect(await q(db(), "judge1", "update public.user_roles set role = 'admin' where user_id = $1 returning user_id", [ids.judge1])).toEqual([]);
    const [role] = await q<{ role: string }>(db(), "superuser", "select role from public.user_roles where user_id = $1", [ids.judge1]);
    expect(role!.role).toBe("judge");
    expect((await fails(db(), "judge1", "delete from public.submissions where id = $1", [sub])).code).toBe(PG.insufficientPrivilege);
  });

  it("see only the safe projection: anonymous id, event, video reference, own marks", async () => {
    const sub = await piiEntry();
    await assign(ids.judge1, sub);
    const rows = await q<Record<string, unknown>>(db(), "judge1", "select * from public.judge_entries");
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "entry_code", "entry_id", "event_id", "event_name_en", "event_name_ta", "my_comments", "my_marks", "score_id", "score_status", "video_key",
    ]);
    expect(rows[0]).toMatchObject({ entry_id: sub, event_id: 3, event_name_en: "Thirukkural Talent" });
    expect(String(rows[0]!.entry_code)).toMatch(/^RIO-[0-9A-F]{5}-[0-9A-F]{5}$/);
    expect(JSON.stringify(rows)).not.toMatch(new RegExp(NEEDLES.join("|"), "i"));
  });

  it("do not see entries assigned to someone else, unassigned entries, or withdrawn entries", async () => {
    const mine = await piiEntry(ids.parentA);
    const theirs = await insertDraft(db(), { owner: ids.parentB, childName: "Other Kid", mobile: "9123456780", email: "o@example.test" });
    await finalize(db(), theirs);
    await assign(ids.judge1, mine);
    await assign(ids.judge2, theirs);
    expect((await q<{ entry_id: string }>(db(), "judge1", "select entry_id from public.judge_entries")).map((r) => r.entry_id)).toEqual([mine]);
    expect((await q<{ entry_id: string }>(db(), "judge2", "select entry_id from public.judge_entries")).map((r) => r.entry_id)).toEqual([theirs]);
    await q(db(), "admin", "select public.withdraw_submission($1)", [mine]);
    expect(await count("judge1", "public.judge_entries")).toBe(0);
  });

  it("find no personal data in any relation, function error or view they can reach", async () => {
    const sub = await piiEntry();
    await assign(ids.judge1, sub);
    await actAs(db(), "judge1");
    await db().query("insert into public.scores (submission_id, marks, comments, status) values ($1, 88, 'good diction', 'draft')", [sub]);

    await actAs(db(), "superuser");
    const rels = (await db().query<{ relname: string }>("select relname from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','v','p') order by 1")).rows.map((r) => r.relname);
    expect(rels.length).toBeGreaterThanOrEqual(11);

    let readable = 0;
    let corpus = "";
    for (const rel of rels) {
      await actAs(db(), "judge1");
      await db().exec("savepoint scan");
      try {
        const res = await db().query<{ t: string }>(`select to_jsonb(x)::text as t from public.${rel} x`);
        corpus += res.rows.map((r) => r.t).join("\n");
        readable++;
      } catch (e) {
        expect((e as { code?: string }).code, rel).toBe(PG.insufficientPrivilege);
        await db().exec("rollback to savepoint scan");
      }
    }
    expect(readable).toBeGreaterThan(0);
    expect(corpus).not.toMatch(new RegExp(NEEDLES.join("|"), "i"));

    for (const sql of ["select public.withdraw_submission($1)", "select public.unlock_score($1)"]) {
      const e = await fails(db(), "judge1", sql, [sub]);
      expect(e.message).not.toMatch(new RegExp(NEEDLES.join("|"), "i"));
    }
  });

  it("score only assigned, finalized entries, independently of other judges", async () => {
    const sub = await piiEntry();
    const other = await insertDraft(db(), { owner: ids.parentB, childName: "Other Kid", mobile: "9123456780", email: "o@example.test" });
    await finalize(db(), other);
    await assign(ids.judge1, sub);
    await assign(ids.judge2, sub);

    expect((await fails(db(), "judge1", "insert into public.scores (submission_id, marks, status) values ($1, 50, 'draft')", [other])).code).toBe(PG.insufficientPrivilege);
    expect((await fails(db(), "judge1", "insert into public.scores (judge_id, submission_id, marks) values ($1, $2, 50)", [ids.judge2, sub])).code).toBe(PG.insufficientPrivilege);

    await q(db(), "judge1", "insert into public.scores (submission_id, marks, status) values ($1, 61, 'draft')", [sub]);
    await q(db(), "judge2", "insert into public.scores (submission_id, marks, status) values ($1, 92, 'draft')", [sub]);
    expect((await q<{ marks: string }>(db(), "judge1", "select marks from public.scores")).map((r) => Number(r.marks))).toEqual([61]);
    expect((await q<{ marks: string }>(db(), "judge2", "select marks from public.scores")).map((r) => Number(r.marks))).toEqual([92]);
    expect((await fails(db(), "judge1", "insert into public.scores (submission_id, marks) values ($1, 70)", [sub])).code).toBe(PG.uniqueViolation);
    expect((await fails(db(), "judge1", "insert into public.scores (submission_id, marks) values ($1, 101)", [other])).code).toBe(PG.insufficientPrivilege);
  });

  it("can edit a draft and finalize it, after which it is read-only for them", async () => {
    const sub = await piiEntry();
    await assign(ids.judge1, sub);
    const [s] = await q<{ id: string }>(db(), "judge1", "insert into public.scores (submission_id, marks) values ($1, 40) returning id", [sub]);
    expect(await q(db(), "judge1", "update public.scores set marks = 55 where id = $1 returning id", [s!.id])).toHaveLength(1);
    expect(await q(db(), "judge1", "update public.scores set status = 'final' where id = $1 returning id", [s!.id])).toHaveLength(1);
    expect(await q(db(), "judge1", "update public.scores set marks = 99 where id = $1 returning id", [s!.id])).toEqual([]);
    expect(await q(db(), "judge1", "update public.scores set status = 'draft' where id = $1 returning id", [s!.id])).toEqual([]);
    const [view] = await q<{ my_marks: string; score_status: string }>(db(), "judge1", "select my_marks, score_status from public.judge_entries");
    expect(view).toMatchObject({ score_status: "final" });
    expect(Number(view!.my_marks)).toBe(55);
    expect((await fails(db(), "judge1", "select public.unlock_score($1)", [s!.id])).message).toBe("forbidden");
  });

  it("lose access when deactivated", async () => {
    const sub = await piiEntry();
    await assign(ids.judge1, sub);
    await actAs(db(), "superuser");
    await db().query("update public.judge_profiles set active = false where user_id = $1", [ids.judge1]);
    expect(await count("judge1", "public.judge_entries")).toBe(0);
    expect((await fails(db(), "judge1", "insert into public.scores (submission_id, marks) values ($1, 50)", [sub])).code).toBe(PG.insufficientPrivilege);
  });

  it("cannot read audit logs, winners, other judges' assignments or roles", async () => {
    const sub = await piiEntry();
    await assign(ids.judge2, sub);
    for (const rel of ["audit_log", "winners", "judge_assignments"]) expect(await count("judge1", `public.${rel}`), rel).toBe(0);
    expect((await q<{ user_id: string }>(db(), "judge1", "select user_id from public.user_roles")).map((r) => r.user_id)).toEqual([ids.judge1]);
    expect((await q<{ user_id: string }>(db(), "judge1", "select user_id from public.judge_profiles")).map((r) => r.user_id)).toEqual([ids.judge1]);
    expect((await fails(db(), "judge1", "select * from auth.users")).code).toBe(PG.insufficientPrivilege);
  });
});

describe("role assignment", () => {
  it("is possible only for administrators", async () => {
    await q(db(), "admin", "insert into public.user_roles (user_id, role) values ($1, 'judge')", [ids.stranger]);
    await q(db(), "admin", "insert into public.judge_profiles (user_id, display_name) values ($1, 'New Judge')", [ids.stranger]);
    const [r] = await q<{ granted_by: string }>(db(), "admin", "select granted_by from public.user_roles where user_id = $1", [ids.stranger]);
    expect(r!.granted_by).toBe(ids.admin); // stamped by the database, not client-supplied
    expect((await fails(db(), "admin", "insert into public.user_roles (user_id, role, granted_by) values ($1, 'admin', $2)", [ids.parentA, ids.admin])).code).toBe(PG.insufficientPrivilege);

    for (const who of ["parentA", "judge1", "stranger", "anon"] as const) {
      const e = await fails(db(), who, "insert into public.user_roles (user_id, role) values ($1, 'admin')", [ids.parentB]);
      expect(e.code, who).toBe(PG.insufficientPrivilege);
    }
    expect(await q(db(), "judge1", "update public.user_roles set role = 'judge' where user_id = $1 returning user_id", [ids.judge2])).toEqual([]);
  });

  it("is ignored when a user claims a role in their token metadata", async () => {
    await actAs(db(), "superuser");
    await db().exec("select set_config('request.jwt.claims', '{\"sub\":\"" + ids.stranger + "\",\"role\":\"authenticated\",\"user_metadata\":{\"role\":\"admin\"},\"app_metadata\":{\"role\":\"admin\"}}', true); set local role authenticated");
    expect((await db().query("select private.is_admin() as a, private.is_judge() as j")).rows[0]).toEqual({ a: false, j: false });
    expect(await count("stranger", "public.submissions")).toBe(0);
  });
});

describe("administrators", () => {
  it("read all registrations but cannot edit them or their status directly", async () => {
    const a = await piiEntry(ids.parentA);
    await insertDraft(db(), { owner: ids.parentB, childName: "Other", mobile: "9123456780", email: "o@example.test" });
    expect(await count("admin", "public.submissions")).toBe(2);
    expect(await q(db(), "admin", "update public.submissions set child_name = 'x' where id = $1 returning id", [a])).toEqual([]);
    expect((await fails(db(), "admin", "update public.submissions set status = 'withdrawn' where id = $1", [a])).code).toBe(PG.insufficientPrivilege);
  });

  it("can take down an entry, which revokes judge access", async () => {
    const sub = await piiEntry();
    await assign(ids.judge1, sub);
    await q(db(), "admin", "select public.withdraw_submission($1)", [sub]);
    const [r] = await q<{ status: string }>(db(), "admin", "select status from public.submissions where id = $1", [sub]);
    expect(r!.status).toBe("withdrawn");
    expect(await count("judge1", "public.judge_entries")).toBe(0);
  });

  it("manage assignments and read every judge's marks to rank entries", async () => {
    const sub = await piiEntry();
    await q(db(), "admin", "insert into public.judge_assignments (judge_id, submission_id) values ($1, $2), ($3, $2)", [ids.judge1, sub, ids.judge2]);
    await q(db(), "judge1", "insert into public.scores (submission_id, marks, status) values ($1, 70, 'final')", [sub]);
    await q(db(), "judge2", "insert into public.scores (submission_id, marks, status) values ($1, 90, 'final')", [sub]);
    expect(await count("admin", "public.scores")).toBe(2);
    expect(await q(db(), "admin", "update public.scores set marks = 1 returning id")).toEqual([]);
  });

  it("write an audit trail that holds ids and states but no personal data", async () => {
    const sub = await piiEntry();
    await assign(ids.judge1, sub);
    await q(db(), "admin", "select public.withdraw_submission($1)", [sub]);
    const rows = await q<{ table_name: string; action: string; details: unknown }>(db(), "admin", "select table_name, action, details from public.audit_log");
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.some((r) => r.table_name === "submissions" && r.action === "UPDATE")).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(new RegExp(NEEDLES.join("|"), "i"));
    expect((await fails(db(), "admin", "update public.audit_log set action = 'x'")).code).toBe(PG.insufficientPrivilege);
    expect((await fails(db(), "admin", "delete from public.audit_log")).code).toBe(PG.insufficientPrivilege);
    expect(await count("parentA", "public.audit_log")).toBe(0);
  });

  it("cannot remove the last administrator through the API", async () => {
    await q(db(), "admin", "delete from public.user_roles where user_id = $1", [ids.admin2]);
    expect((await fails(db(), "admin", "delete from public.user_roles where user_id = $1", [ids.admin])).message).toContain("last_admin");
  });
});

describe("winner publication", () => {
  async function winnerFixture(): Promise<string> {
    const sub = await piiEntry();
    await q(db(), "admin", "insert into public.winners (event_id, submission_id, rank, award_label, display_name) values (3, $1, 1, 'Thirukkural Talent', 'Zora')", [sub]);
    return sub;
  }

  it("only an administrator can approve winners; approver is stamped by the database", async () => {
    const sub = await piiEntry();
    for (const who of ["parentA", "judge1", "stranger", "anon"] as const) {
      const e = await fails(db(), who, "insert into public.winners (event_id, submission_id, rank, display_name) values (3, $1, 1, 'x')", [sub]);
      expect(e.code, who).toBe(PG.insufficientPrivilege);
    }
    // even if an administrator tries to name a different approver, the database stamps the signed-in one
    await q(db(), "admin", "insert into public.winners (event_id, submission_id, rank, display_name, approved_by) values (3, $1, 1, 'Zora', $2)", [sub, ids.admin2]);
    const [w] = await q<{ approved_by: string }>(db(), "admin", "select approved_by from public.winners");
    expect(w!.approved_by).toBe(ids.admin);
  });

  it("must be a finalized entry in the matching event", async () => {
    const draft = await insertDraft(db(), { owner: ids.parentA });
    expect((await fails(db(), "admin", "insert into public.winners (event_id, submission_id, rank, display_name) values (2, $1, 1, 'x')", [draft])).message).toContain("submission_not_finalized");
    const sub = await piiEntry();
    expect((await fails(db(), "admin", "insert into public.winners (event_id, submission_id, rank, display_name) values (1, $1, 1, 'x')", [sub])).message).toContain("event_mismatch");
  });

  it("stay hidden until an administrator schedules publication", async () => {
    await winnerFixture();
    expect(await count("anon", "public.published_winners")).toBe(0);
    expect(await count("parentA", "public.published_winners")).toBe(0);
    expect(await count("admin", "public.winners")).toBe(1);

    await q(db(), "admin", "update public.event_settings set results_publish_at = '2099-01-01 00:00:00+05:30'");
    expect(await count("anon", "public.published_winners")).toBe(0);

    for (const who of ["parentA", "judge1", "stranger"] as const) {
      expect(await q(db(), who, "update public.event_settings set results_publish_at = '2026-11-14 00:00:00+05:30' returning id"), who).toEqual([]);
    }
  });

  it("appear to everyone, with display fields only, once the publish time has passed", async () => {
    await winnerFixture();
    await actAs(db(), "superuser");
    // The 14 Nov floor cannot be passed yet on the calendar, so lift it inside this rolled-back transaction
    await db().exec("alter table public.event_settings drop constraint settings_results_floor");
    await q(db(), "admin", "update public.event_settings set results_publish_at = now() - interval '1 minute'");
    for (const who of ["anon", "parentA", "judge1"] as const) {
      const rows = await q<Record<string, unknown>>(db(), who, "select * from public.published_winners");
      expect(rows, who).toEqual([{ event_id: 3, rank: 1, award_label: "Thirukkural Talent", display_name: "Zora" }]);
    }
    expect((await fails(db(), "anon", "select * from public.winners")).code).toBe(PG.insufficientPrivilege);
    await q(db(), "admin", "update public.event_settings set results_publish_at = null"); // unpublish
    expect(await count("anon", "public.published_winners")).toBe(0);
  });
});

describe("optional media consent (M3B)", () => {
  const INSERT = "insert into public.submissions (event_id, child_name, child_age, parent_name, parent_email, parent_mobile, consent_version, media_consent) values (2,'Asha Test',6,'Parent Test','p@example.test','9876543210','v1',$1) returning id, media_consent";

  it("defaults to no consent, and a parent can give it at registration or change it while the entry is a draft", async () => {
    const [plain] = await q<{ media_consent: boolean }>(db(), "parentA", "insert into public.submissions (event_id, child_name, child_age, parent_name, parent_email, parent_mobile, consent_version) values (2,'Asha Test',6,'Parent Test','p@example.test','9876543210','v1') returning media_consent");
    expect(plain!.media_consent).toBe(false);
    const [given] = await q<{ id: string; media_consent: boolean }>(db(), "parentB", INSERT, [true]);
    expect(given!.media_consent).toBe(true);
    expect(await q(db(), "parentB", "update public.submissions set media_consent = false where id = $1 returning id", [given!.id])).toHaveLength(1);
    const [now] = await q<{ media_consent: boolean }>(db(), "parentB", "select media_consent from public.submissions where id = $1", [given!.id]);
    expect(now!.media_consent).toBe(false);
  });

  it("cannot be set on, or read from, another parent's entry", async () => {
    const a = await insertDraft(db(), { owner: ids.parentA });
    expect(await q(db(), "parentB", "update public.submissions set media_consent = true where id = $1 returning id", [a])).toEqual([]);
    expect(await q(db(), "parentB", "select media_consent from public.submissions where id = $1", [a])).toEqual([]);
    const [still] = await q<{ media_consent: boolean }>(db(), "superuser", "select media_consent from public.submissions where id = $1", [a]);
    expect(still!.media_consent).toBe(false);
  });

  it("is locked once the entry is finalized, and judges never see it", async () => {
    const a = await insertDraft(db(), { owner: ids.parentA });
    await finalize(db(), a);
    expect(await q(db(), "parentA", "update public.submissions set media_consent = true where id = $1 returning id", [a])).toEqual([]);
    await assign(ids.judge1, a);
    const rows = await q<Record<string, unknown>>(db(), "judge1", "select * from public.judge_entries");
    expect(Object.keys(rows[0]!)).not.toContain("media_consent");
    expect(await q(db(), "judge1", "select media_consent from public.submissions")).toEqual([]);
  });
});
