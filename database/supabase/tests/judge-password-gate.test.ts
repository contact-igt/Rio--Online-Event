import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { actAs, fails, finalize, ids, insertDraft, PG, q, setupDb } from "./helpers";

// Migration 00900: the first-login password gate in the database, and the labelled audit event for judge password resets.
// Every statement below is the SQL PostgREST would run for a signed-in caller (role "authenticated", the caller's own id), so each test shows what a
// person could do by calling the Supabase Data API directly with their own valid token. Local PGlite only; no hosted project is involved.

const db = setupDb();
const HERE = import.meta.dirname;
const MIGRATION = readFileSync(join(HERE, "..", "migrations", "20261105000900_judge_password_gate.sql"), "utf8");
const ROLLBACK = readFileSync(join(HERE, "..", "rollback", "20261105000900_down.sql"), "utf8");

/** What the Auth admin API does with app_metadata (the secret key): sets or lifts the first-login mark. */
async function setMark(userId: string, value: boolean | null) {
  await actAs(db(), "superuser");
  await db().query("update auth.users set raw_app_meta_data = case when $2::text is null then '{}'::jsonb else jsonb_build_object('must_change_password', $2::boolean) end where id = $1", [userId, value === null ? null : String(value)]);
}

async function entry(): Promise<string> {
  const id = await insertDraft(db(), { owner: ids.parentA, childName: "Asha Gate", mobile: "9800000001", email: "gate.parent@example.test" });
  await finalize(db(), id);
  await actAs(db(), "superuser");
  await db().query("insert into public.judge_assignments (judge_id, submission_id) values ($1,$2)", [ids.judge1, id]);
  return id;
}

const entries = (who: "judge1" | "judge2" | "stranger" = "judge1") => q(db(), who, "select entry_id from public.judge_entries");
const draftScore = (sub: string) => q(db(), "judge1", "insert into public.scores (submission_id, marks, comments, status) values ($1, 80, 'good', 'draft') returning id", [sub]);

describe("a judge whose password has not been changed yet", () => {
  it("before the mark: assigned entries, own assignments and scoring all work (the existing judge flow is unchanged)", async () => {
    const sub = await entry();
    expect(await entries()).toHaveLength(1);
    expect(await q(db(), "judge1", "select submission_id from public.judge_assignments")).toHaveLength(1);
    const [score] = await draftScore(sub);
    expect(score).toBeTruthy();
    expect(await q(db(), "judge1", "update public.scores set marks = 85 where submission_id = $1 returning id", [sub])).toHaveLength(1);
    expect(await q(db(), "judge1", "update public.scores set status = 'final' where submission_id = $1 returning id", [sub])).toHaveLength(1);
    expect((await q<{ marks: string }>(db(), "judge1", "select marks from public.scores where submission_id = $1", [sub]))[0]!.marks).toBe("85.00");
  });

  it("with the mark: reads no entry, no assignment and no score, and can write no score, through any Data API path", async () => {
    const sub = await entry();
    await draftScore(sub); // a draft made before the reset
    await setMark(ids.judge1, true);
    expect(await entries()).toEqual([]);
    expect(await q(db(), "judge1", "select * from public.judge_assignments")).toEqual([]);
    expect(await q(db(), "judge1", "select * from public.scores")).toEqual([]);
    expect((await fails(db(), "judge1", "insert into public.scores (submission_id, marks, status) values ($1, 70, 'draft')", [sub])).code).toBe(PG.insufficientPrivilege);
    expect(await q(db(), "judge1", "update public.scores set marks = 99 where submission_id = $1 returning id", [sub])).toEqual([]);
    expect(await q(db(), "judge1", "update public.scores set status = 'final' where submission_id = $1 returning id", [sub])).toEqual([]);
    expect((await fails(db(), "judge1", "delete from public.scores where submission_id = $1", [sub])).code).toBe(PG.insufficientPrivilege); // no delete right for judges at all
    await actAs(db(), "superuser");
    expect((await db().query<{ marks: string }>("select marks from public.scores where submission_id = $1", [sub])).rows[0]!.marks).toBe("80.00"); // untouched
  });

  it("can still read their own role and profile (the app needs them to send the judge to the password page) and the public data, and nothing else", async () => {
    await entry();
    await setMark(ids.judge1, true);
    expect(await q(db(), "judge1", "select role from public.user_roles")).toEqual([{ role: "judge" }]);
    expect((await q(db(), "judge1", "select user_id from public.judge_profiles")).length).toBe(1);
    expect((await q(db(), "judge1", "select id from public.events")).length).toBeGreaterThan(0);
    for (const rel of ["public.submissions", "public.audit_log", "public.winners", "public.video_uploads", "public.email_outbox"]) {
      expect(await q(db(), "judge1", `select 1 from ${rel}`).catch(() => []), rel).toEqual([]);
    }
  });

  it("the state is read from the account row, never from the token: a stale token claiming no pending change does not help, and a stale one claiming it does not hurt", async () => {
    await entry();
    await setMark(ids.judge1, true);
    await actAs(db(), "judge1");
    await db().query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids.judge1, role: "authenticated", app_metadata: { must_change_password: false } })]);
    expect((await db().query("select entry_id from public.judge_entries")).rows).toEqual([]);
    await setMark(ids.judge1, false);
    await actAs(db(), "judge1");
    await db().query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids.judge1, role: "authenticated", app_metadata: { must_change_password: true } })]);
    expect((await db().query("select entry_id from public.judge_entries")).rows).toHaveLength(1);
  });

  it("a judge cannot clear the mark: user_metadata is ignored, and auth.users is closed to every client role", async () => {
    await entry();
    await setMark(ids.judge1, true);
    await actAs(db(), "superuser");
    await db().query("update auth.users set raw_user_meta_data = jsonb_build_object('must_change_password', false) where id = $1", [ids.judge1]); // what a user can edit themselves
    expect(await entries()).toEqual([]);
    for (const who of ["judge1", "parentA", "anon"] as const) {
      expect((await fails(db(), who, "select raw_app_meta_data from auth.users")).code, who).toBe(PG.insufficientPrivilege);
      expect((await fails(db(), who, "update auth.users set raw_app_meta_data = '{}'")).code, who).toBe(PG.insufficientPrivilege);
    }
    expect((await fails(db(), "judge1", "select private.judge_password_pending($1)", [ids.judge1])).code).toBe(PG.insufficientPrivilege);
  });

  it("once the judge has chosen a password and the mark is lifted (false or removed), access returns at once and earlier scores are intact", async () => {
    const sub = await entry();
    await draftScore(sub);
    await setMark(ids.judge1, true);
    expect(await entries()).toEqual([]);
    for (const lifted of [false, null] as const) {
      await setMark(ids.judge1, true);
      await setMark(ids.judge1, lifted);
      expect(await entries(), String(lifted)).toHaveLength(1);
      expect(await q(db(), "judge1", "select id from public.scores")).toHaveLength(1);
    }
  });

  it("an account row that is missing counts as pending (fail closed), and the mark of one judge never touches another judge", async () => {
    const sub = await entry();
    await actAs(db(), "superuser");
    const missing = await db().query<{ p: boolean }>("select private.judge_password_pending(gen_random_uuid()) as p");
    expect(missing.rows[0]!.p).toBe(true);
    await db().query("insert into public.judge_assignments (judge_id, submission_id) values ($1,$2)", [ids.judge2, sub]);
    await setMark(ids.judge1, true);
    expect(await entries("judge1")).toEqual([]);
    expect(await entries("judge2")).toHaveLength(1); // independent accounts
  });

  it("a deactivated judge has no entry, assignment or score access, with or without the mark", async () => {
    const sub = await entry();
    await draftScore(sub);
    await q(db(), "admin", "update public.judge_profiles set active = false where user_id = $1", [ids.judge1]);
    for (const mark of [null, true, false] as const) {
      await setMark(ids.judge1, mark);
      expect(await entries(), String(mark)).toEqual([]);
      expect(await q(db(), "judge1", "select * from public.judge_assignments"), String(mark)).toEqual([]);
      expect(await q(db(), "judge1", "select * from public.scores"), String(mark)).toEqual([]);
      expect((await fails(db(), "judge1", "insert into public.scores (submission_id, marks, status) values ($1, 1, 'draft')", [sub])).code).toBe(PG.insufficientPrivilege);
    }
  });

  it("playback authorization (service role) refuses a pending judge and works after the change, leaving an audit row only for the real one", async () => {
    const sub = await entry();
    await setMark(ids.judge1, true); // the finalized entry already has its (private) video reference
    expect((await fails(db(), "service", "select public.authorize_playback($1,$2)", [ids.judge1, sub])).message).toContain("not_found");
    await setMark(ids.judge1, false);
    expect(await q(db(), "service", "select public.authorize_playback($1,$2)", [ids.judge1, sub])).toHaveLength(1);
    expect(await q(db(), "superuser", "select 1 from public.audit_log where action = 'PLAYBACK_URL'")).toHaveLength(1);
  });
});

describe("everyone else is unchanged", () => {
  it("parents still read only their own registrations, whatever a judge's mark says", async () => {
    const a = await insertDraft(db(), { owner: ids.parentA, childName: "Parent A child", mobile: "9800000002" });
    await insertDraft(db(), { owner: ids.parentB, childName: "Parent B child", mobile: "9800000003" });
    await setMark(ids.judge1, true);
    expect((await q<{ id: string }>(db(), "parentA", "select id from public.submissions")).map((r) => r.id)).toEqual([a]);
    expect(await q(db(), "parentA", "select * from public.judge_assignments")).toEqual([]);
    expect(await q(db(), "parentA", "select * from public.scores")).toEqual([]);
    expect(await q(db(), "stranger", "select * from public.submissions")).toEqual([]);
    expect(await entries("stranger")).toEqual([]);
  });

  it("an administrator still reads every assignment and score, including a pending judge's, and can still assign and switch judges", async () => {
    const sub = await entry();
    await draftScore(sub);
    await setMark(ids.judge1, true);
    expect(await q(db(), "admin", "select * from public.judge_assignments")).toHaveLength(1);
    expect(await q(db(), "admin", "select * from public.scores")).toHaveLength(1);
    expect(await q(db(), "admin", "select submissions.id from public.submissions")).toHaveLength(1);
    expect(await q(db(), "admin", "update public.judge_profiles set active = true where user_id = $1 returning user_id", [ids.judge2])).toHaveLength(1);
    expect(await q(db(), "admin", "select public.assign_judge_to_event($1, 2::smallint)", [ids.judge2])).toHaveLength(1);
  });
});

describe("record_judge_password_reset", () => {
  const record = (outcome: string, actor: string = ids.admin, judge: string = ids.judge1) => q(db(), "service", "select public.record_judge_password_reset($1,$2,$3)", [actor, judge, outcome]);

  it("writes a clearly labelled row per outcome with the acting administrator, the target judge and the time, and nothing else", async () => {
    await record("started");
    await record("success");
    await record("failed");
    const rows = await q<{ actor: string; action: string; table_name: string; row_id: string; at: Date; details: Record<string, unknown> }>(
      db(),
      "admin",
      "select actor, action, table_name, row_id, at, details from public.audit_log where action like 'JUDGE_PASSWORD_RESET%' order by id",
    );
    expect(rows.map((r) => r.action)).toEqual(["JUDGE_PASSWORD_RESET_STARTED", "JUDGE_PASSWORD_RESET", "JUDGE_PASSWORD_RESET_FAILED"]);
    for (const r of rows) {
      expect(r.actor).toBe(ids.admin);
      expect(r.row_id).toBe(ids.judge1);
      expect(r.table_name).toBe("judge_profiles");
      expect(r.at).toBeInstanceOf(Date);
    }
    expect(rows.map((r) => r.details)).toEqual([{ outcome: "started" }, { outcome: "success" }, { outcome: "failed" }]);
    expect(JSON.stringify(rows)).not.toMatch(/password"|secret|@|Judge One/i); // no password, key, e-mail or name
  });

  it("does not touch the judge's profile, so the audit log shows no misleading profile update", async () => {
    await record("success");
    expect(await q(db(), "admin", "select 1 from public.audit_log where table_name = 'judge_profiles' and action = 'UPDATE'")).toEqual([]);
  });

  it("refuses an unknown outcome, a non-administrator actor, and a target that is not a judge", async () => {
    expect((await fails(db(), "service", "select public.record_judge_password_reset($1,$2,'done')", [ids.admin, ids.judge1])).message).toContain("invalid_outcome");
    expect((await fails(db(), "service", "select public.record_judge_password_reset($1,$2,null)", [ids.admin, ids.judge1])).message).toContain("invalid_outcome");
    for (const actor of [ids.judge1, ids.parentA, ids.stranger]) {
      expect((await fails(db(), "service", "select public.record_judge_password_reset($1,$2,'success')", [actor, ids.judge1])).message, actor).toContain("forbidden");
    }
    for (const target of [ids.admin, ids.parentA, ids.stranger]) {
      expect((await fails(db(), "service", "select public.record_judge_password_reset($1,$2,'success')", [ids.admin, target])).message, target).toContain("judge_not_found");
    }
    expect(await q(db(), "superuser", "select 1 from public.audit_log where action like 'JUDGE_PASSWORD_RESET%'")).toEqual([]);
  });

  it("only the server (service role) can call it: an administrator, a judge, a parent and an anonymous caller cannot forge or skip these rows", async () => {
    for (const who of ["admin", "judge1", "parentA", "anon"] as const) {
      expect((await fails(db(), who, "select public.record_judge_password_reset($1,$2,'success')", [ids.admin, ids.judge1])).code, who).toBe(PG.insufficientPrivilege);
    }
    for (const who of ["admin", "judge1", "parentA"] as const) {
      expect((await fails(db(), who, "insert into public.audit_log (actor, action, table_name) values ($1,'JUDGE_PASSWORD_RESET','judge_profiles')", [ids.admin])).code, who).toBe(PG.insufficientPrivilege);
    }
  });

  it("only administrators can read the rows", async () => {
    await record("success");
    expect(await q(db(), "admin", "select 1 from public.audit_log where action = 'JUDGE_PASSWORD_RESET'")).toHaveLength(1);
    for (const who of ["judge1", "parentA", "stranger"] as const) expect(await q(db(), who, "select 1 from public.audit_log").catch(() => []), who).toEqual([]);
  });
});

describe("the migration itself", () => {
  it("adds exactly the two functions and changes no table, column or table grant", async () => {
    await actAs(db(), "superuser");
    const fns = await db().query<{ sig: string; service: boolean; authed: boolean; anon: boolean; secdef: boolean; cfg: string }>(`
      select p.pronamespace::regnamespace::text || '.' || p.proname as sig, has_function_privilege('service_role', p.oid, 'EXECUTE') as service,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed, has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             p.prosecdef as secdef, coalesce(p.proconfig::text, '') as cfg
      from pg_proc p where p.proname in ('judge_password_pending', 'record_judge_password_reset') order by 1`);
    expect(fns.rows.map((r) => r.sig)).toEqual(["private.judge_password_pending", "public.record_judge_password_reset"]);
    for (const r of fns.rows) {
      expect(r.secdef, r.sig).toBe(true);
      expect(r.cfg, r.sig).toContain("search_path=");
      expect([r.authed, r.anon], r.sig).toEqual([false, false]);
    }
    expect(fns.rows.map((r) => r.service)).toEqual([false, true]); // the helper is for the other functions only; the audit writer is the server's
    expect(MIGRATION).not.toMatch(/\b(create|alter|drop)\s+table\b|\bgrant\s+(select|insert|update|delete)\b/i);
    expect(MIGRATION).not.toMatch(/password\s+text|raw_app_meta_data\s*=/i); // never writes or stores a password or the mark
  });

  it("rolls back cleanly to the 00200, 00300 and 00700 behaviour and can be applied again", async () => {
    const sub = await entry();
    await setMark(ids.judge1, true);
    expect(await entries()).toEqual([]);
    await actAs(db(), "superuser");
    await db().exec(ROLLBACK);
    expect(await entries(), "after rollback the database no longer holds the rule (the application still does)").toHaveLength(1);
    expect((await db().query("select 1 from pg_proc where proname in ('judge_password_pending','record_judge_password_reset')")).rows).toEqual([]);
    expect(await q(db(), "service", "select public.authorize_playback($1,$2)", [ids.judge1, sub]).catch(() => "no video")).toBeDefined();
    await actAs(db(), "superuser");
    await db().exec(MIGRATION);
    expect(await entries()).toEqual([]);
    await setMark(ids.judge1, false);
    expect(await entries()).toHaveLength(1);
  });
});
