import { describe, expect, it } from "vitest";
import { actAs, fails, ids, insertDraft, PG, q, setupDb, uploadVerified } from "./helpers";

// M5/M6 database support (migration 00700) and the security properties of the final-submission and playback functions.

const db = setupDb();

async function finalized(owner: string, name: string, event = 2): Promise<{ id: string; videoId: string }> {
  const id = await insertDraft(db(), { owner, childName: name, event, mobile: `98${String(Math.abs(hash(name))).padStart(8, "0").slice(0, 8)}` });
  const v = await uploadVerified(db(), owner, id);
  await actAs(db(), "service");
  await db().query("select public.finalize_verified_submission($1,$2,$3,$4,$5,$6)", [owner, id, v.upload, v.bytes, v.type, v.etag]);
  return { id, videoId: v.upload };
}
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
const assign = async (judge: string, submission: string) => {
  await actAs(db(), "superuser");
  await db().query("insert into public.judge_assignments (judge_id, submission_id) values ($1,$2)", [judge, submission]);
};
const playback = (judge: string, submission: string) => q<{ authorize_playback: string }>(db(), "service", "select public.authorize_playback($1,$2)", [judge, submission]);
const playbackFails = async (judge: string, submission: string) => (await fails(db(), "service", "select public.authorize_playback($1,$2)", [judge, submission])).message;

describe("function security (migrations 00600 and 00700)", () => {
  it("every new function is SECURITY DEFINER with an empty search_path, owned by the migration role, and not executable by PUBLIC or anon", async () => {
    await actAs(db(), "superuser");
    const res = await db().query<{ name: string; secdef: boolean; config: string; pub: boolean; anon: boolean; authed: boolean; service: boolean; owner: string }>(`
      select p.proname as name, p.prosecdef as secdef, coalesce(p.proconfig::text, '') as config,
             (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')) as pub,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as service,
             pg_get_userbyid(p.proowner) as owner
      from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('check_finalize', 'finalize_verified_submission', 'authorize_playback', 'assign_judge_to_event')
      order by 1`);
    expect(res.rows.map((r) => r.name)).toEqual(["assign_judge_to_event", "authorize_playback", "check_finalize", "finalize_verified_submission"]);
    for (const r of res.rows) {
      expect(r.secdef, r.name).toBe(true);
      expect(r.config, r.name).toContain("search_path=");
      expect(r.pub, r.name).toBe(false);
      expect(r.anon, r.name).toBe(false);
      expect(r.owner, r.name).not.toBe("authenticated");
    }
    // service-role-only: the three server-side functions; the admin function is the one authenticated users may call (and checks the role itself)
    expect(res.rows.filter((r) => r.authed).map((r) => r.name)).toEqual(["assign_judge_to_event"]);
    for (const r of res.rows.filter((x) => x.name !== "assign_judge_to_event")) expect(r.service, r.name).toBe(true);
  });

  it("the removed finalizer is absent and the new tables and policies are unchanged (no unrelated schema change)", async () => {
    await actAs(db(), "superuser");
    const gone = await db().query("select 1 from pg_proc where proname = 'finalize_submission' and pronamespace = 'public'::regnamespace");
    expect(gone.rows).toEqual([]);
    const tables = await db().query<{ relname: string; rls: boolean }>("select relname, relrowsecurity as rls from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1");
    expect(tables.rows.map((t) => t.relname)).toEqual(["audit_log", "email_outbox", "event_settings", "events", "judge_assignments", "judge_profiles", "scores", "submissions", "user_roles", "video_uploads", "winners"]);
    expect(tables.rows.every((t) => t.rls)).toBe(true);
  });
});

describe("authorize_playback", () => {
  it("is callable by the service role only", async () => {
    const { id } = await finalized(ids.parentA, "Asha");
    await assign(ids.judge1, id);
    for (const who of ["anon", "parentA", "judge1", "admin"] as const) {
      expect((await fails(db(), who, "select public.authorize_playback($1,$2)", [ids.judge1, id])).code, who).toBe(PG.insufficientPrivilege);
    }
  });

  it("returns the opaque video id for an active, assigned judge and a finalized entry, and writes an audit row without personal data", async () => {
    const { id, videoId } = await finalized(ids.parentA, "Asha");
    await assign(ids.judge1, id);
    expect((await playback(ids.judge1, id))[0]!.authorize_playback).toBe(videoId);
    const audit = await q<{ actor: string; row_id: string; details: Record<string, unknown> }>(db(), "superuser", "select actor, row_id, details from public.audit_log where action = 'PLAYBACK_URL'");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: ids.judge1, row_id: id, details: { ttl_seconds: 300 } });
    expect(JSON.stringify(audit)).not.toMatch(/Asha|example\.test|98765/);
  });

  it("gives the identical answer for an unassigned judge, another judge, an inactive judge, a draft and an unknown entry", async () => {
    const a = await finalized(ids.parentA, "Asha");
    await assign(ids.judge1, a.id);
    const draft = await insertDraft(db(), { owner: ids.parentB, childName: "Draft" });
    const messages = new Set<string>();
    messages.add(await playbackFails(ids.judge2, a.id)); // not assigned
    messages.add(await playbackFails(ids.parentA, a.id)); // not a judge
    messages.add(await playbackFails(ids.judge1, draft)); // not finalized
    messages.add(await playbackFails(ids.judge1, "00000000-0000-4000-8000-000000000000")); // unknown
    messages.add(await playbackFails("00000000-0000-4000-8000-000000000000", a.id));
    await actAs(db(), "superuser");
    await db().query("update public.judge_profiles set active = false where user_id = $1", [ids.judge1]);
    messages.add(await playbackFails(ids.judge1, a.id)); // deactivated
    expect([...messages]).toEqual(["not_found"]);
    const audit = await q(db(), "superuser", "select 1 from public.audit_log where action = 'PLAYBACK_URL'");
    expect(audit).toEqual([]); // nothing was authorized, nothing was logged as issued
  });

  it("refuses an entry that was withdrawn after finalization", async () => {
    const a = await finalized(ids.parentA, "Asha");
    await assign(ids.judge1, a.id);
    await actAs(db(), "admin");
    await db().query("select public.withdraw_submission($1)", [a.id]);
    expect(await playbackFails(ids.judge1, a.id)).toBe("not_found");
  });
});

describe("assign_judge_to_event", () => {
  it("is for administrators only", async () => {
    await finalized(ids.parentA, "Asha");
    for (const who of ["parentA", "judge1", "judge2"] as const) {
      expect((await fails(db(), who, "select public.assign_judge_to_event($1, 2::smallint)", [ids.judge1])).message, who).toContain("forbidden");
    }
    expect((await fails(db(), "anon", "select public.assign_judge_to_event($1, 2::smallint)", [ids.judge1])).code).toBe(PG.insufficientPrivilege);
  });

  it("assigns every finalized entry of the competition, only those, only once, and reports how many", async () => {
    const one = await finalized(ids.parentA, "Asha", 2);
    await finalized(ids.parentB, "Bala", 2);
    await finalized(ids.stranger, "Chitra", 3); // another competition
    await insertDraft(db(), { owner: ids.parentA, childName: "Not final", event: 2 }); // a draft
    const first = await q<{ assign_judge_to_event: number }>(db(), "admin", "select public.assign_judge_to_event($1, 2::smallint)", [ids.judge1]);
    expect(first[0]!.assign_judge_to_event).toBe(2);
    expect((await q<{ assign_judge_to_event: number }>(db(), "admin", "select public.assign_judge_to_event($1, 2::smallint)", [ids.judge1]))[0]!.assign_judge_to_event).toBe(0);
    const mine = await q<{ submission_id: string }>(db(), "superuser", "select submission_id from public.judge_assignments where judge_id = $1", [ids.judge1]);
    expect(mine).toHaveLength(2);
    expect(mine.map((r) => r.submission_id)).toContain(one.id);
    // a later finalized entry is picked up by running it again
    await finalized(ids.parentB, "Devi", 2);
    expect((await q<{ assign_judge_to_event: number }>(db(), "admin", "select public.assign_judge_to_event($1, 2::smallint)", [ids.judge1]))[0]!.assign_judge_to_event).toBe(1);
    // who assigned is stamped by the database
    const by = await q<{ assigned_by: string }>(db(), "superuser", "select distinct assigned_by from public.judge_assignments");
    expect(by).toEqual([{ assigned_by: ids.admin }]);
  });

  it("refuses an inactive judge, a user who is not a judge, and an unknown competition", async () => {
    await actAs(db(), "superuser");
    await db().query("update public.judge_profiles set active = false where user_id = $1", [ids.judge2]);
    expect((await fails(db(), "admin", "select public.assign_judge_to_event($1, 2::smallint)", [ids.judge2])).message).toContain("judge_not_found");
    expect((await fails(db(), "admin", "select public.assign_judge_to_event($1, 2::smallint)", [ids.parentA])).message).toContain("judge_not_found");
    expect((await fails(db(), "admin", "select public.assign_judge_to_event($1, 99::smallint)", [ids.judge1])).message).toContain("event_not_found");
  });
});
