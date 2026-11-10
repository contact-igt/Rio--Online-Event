import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { countRegistrations, filterRegistrations, loadRegistration, loadRegistrations, videoLabel } from "../../../admin/lib/admin/registrations";
import { loadJudges } from "../../../admin/lib/staff/judges";
import { actAs, ids, insertDraft, q, setupDb, uploadVerified, finalize, type Who } from "./helpers";

// The administrator's Registrations and Judges screens, run against the REAL migrations and row level security as each kind of user.
// The loaders use the caller's own session, so these tests show what each role actually gets back: an administrator everything, and a judge,
// a parent and an anonymous caller nothing they should not have. No migration is needed for any of it.

const db = setupDb();

/** A thin stand-in for the Supabase client that runs the same select as `who` (PostgREST would do the same). */
function client(who: Who): SupabaseClient {
  return {
    from(table: string) {
      const st = { cols: "*", eq: [] as [string, unknown][], order: null as null | { col: string; asc: boolean }, limit: null as number | null };
      const exec = async () => {
        const where = st.eq.map(([c], i) => `${c} = $${i + 1}`).join(" and ");
        const sql = `select ${st.cols} from public.${table}${where ? ` where ${where}` : ""}${st.order ? ` order by ${st.order.col} ${st.order.asc ? "asc" : "desc"}` : ""}${st.limit ? ` limit ${st.limit}` : ""}`;
        await actAs(db(), who);
        await db().exec("savepoint ex");
        try {
          const res = await db().query(sql, st.eq.map(([, v]) => v));
          await db().exec("release savepoint ex");
          return { data: res.rows, error: null };
        } catch (e) {
          await db().exec("rollback to savepoint ex");
          return { data: null, error: { code: (e as { code?: string }).code, message: (e as Error).message } };
        }
      };
      const b = {
        select(c: string) {
          st.cols = c;
          return b;
        },
        eq(c: string, v: unknown) {
          st.eq.push([c, v]);
          return b;
        },
        order(c: string, o?: { ascending?: boolean }) {
          st.order = { col: c, asc: o?.ascending !== false };
          return b;
        },
        limit(n: number) {
          st.limit = n;
          return b;
        },
        maybeSingle: async () => {
          const r = await exec();
          return { data: r.data?.[0] ?? null, error: r.error };
        },
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => exec().then(ok, bad),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

async function seed() {
  const draft = await insertDraft(db(), { owner: ids.parentA, childName: "Draft Child", event: 2, mobile: "9811111111" });
  const awaiting = await insertDraft(db(), { owner: ids.parentB, childName: "Awaiting Child", event: 2, mobile: "9822222222" });
  await uploadVerified(db(), ids.parentB, awaiting);
  const done = await insertDraft(db(), { owner: ids.parentB, childName: "Done Child", event: 3, age: 7, mobile: "9833333333", email: "done.parent@example.test" });
  await finalize(db(), done);
  const gone = await insertDraft(db(), { owner: ids.parentA, childName: "Gone Child", event: 2, mobile: "9844444444" });
  await actAs(db(), "superuser");
  await db().query("update public.submissions set status = 'withdrawn', withdrawn_at = now() where id = $1", [gone]);
  return { draft, awaiting, done, gone };
}

describe("registrations: who can read them", () => {
  it("an administrator reads every registration with its personal fields; counts come from the rows and only Finalized is complete", async () => {
    const s = await seed();
    const rows = (await loadRegistrations(client("admin")))!;
    expect(rows).toHaveLength(4);
    expect(countRegistrations(rows)).toEqual({ total: 4, draft: 1, awaiting: 1, finalized: 1, withdrawn: 1 });
    const done = rows.find((r) => r.id === s.done)!;
    expect(done).toMatchObject({ childName: "Done Child", parentEmail: "done.parent@example.test", status: "finalized", hasVideo: true });
    expect(done.finalizedAt).not.toBeNull();
    const draft = rows.find((r) => r.id === s.draft)!;
    expect(draft).toMatchObject({ status: "draft", hasVideo: false, finalizedAt: null });
    expect(videoLabel(draft)).toBe("No video yet");
    expect(videoLabel(rows.find((r) => r.id === s.awaiting)!)).toBe("Uploaded and verified");
    expect(JSON.stringify(rows)).not.toMatch(/video_key|videoKey/); // the private object reference never leaves the loader
  });

  it("a judge gets nothing, even for an entry assigned to them: judges have no route to child or parent data", async () => {
    const s = await seed();
    await actAs(db(), "superuser");
    await db().query("insert into public.judge_assignments (judge_id, submission_id) values ($1,$2)", [ids.judge1, s.done]);
    expect(await loadRegistrations(client("judge1"))).toEqual([]);
    expect(await loadRegistration(client("judge1"), s.done)).toBeNull();
  });

  it("a parent reads only their own registrations, and a signed-out caller is refused outright", async () => {
    const s = await seed();
    const a = (await loadRegistrations(client("parentA")))!;
    expect(a.map((r) => r.id).sort()).toEqual([s.draft, s.gone].sort());
    expect(await loadRegistration(client("parentA"), s.done)).toBeNull(); // another parent's entry
    expect(await loadRegistrations(client("anon"))).toBeNull(); // no grant at all: the loader reports failure, not an empty list
  });

  it("the details view returns the whole record to an administrator, and nothing for an unknown id", async () => {
    const s = await seed();
    const r = (await loadRegistration(client("admin"), s.done))!;
    expect(r).toMatchObject({ childName: "Done Child", childAge: 7, parentName: "Parent Test", parentMobile: "9833333333", consentVersion: "v1", status: "finalized" });
    expect(r.consentAt).not.toBeNull();
    expect(await loadRegistration(client("admin"), "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("search and filters work on the rows read, and a draft is never found under Finalized", async () => {
    await seed();
    const rows = (await loadRegistrations(client("admin")))!;
    expect(filterRegistrations(rows, { q: "done child", status: "", event: null }).map((r) => r.childName)).toEqual(["Done Child"]);
    expect(filterRegistrations(rows, { q: "9833333333", status: "", event: null })).toHaveLength(1);
    expect(filterRegistrations(rows, { q: "", status: "finalized", event: null }).map((r) => r.childName)).toEqual(["Done Child"]);
    expect(filterRegistrations(rows, { q: "draft child", status: "finalized", event: null })).toEqual([]);
    expect(filterRegistrations(rows, { q: "", status: "", event: 2 })).toHaveLength(3);
  });
});

describe("judges: the screen's data and the actions' database rules", () => {
  async function assignedJudge() {
    const s = await seed();
    await actAs(db(), "superuser");
    await db().query("insert into public.judge_assignments (judge_id, submission_id) values ($1,$2)", [ids.judge1, s.done]);
    return s;
  }

  it("an administrator sees every judge with assigned counts and progress; a never-signed-in judge is Invited, a returning one Active", async () => {
    await assignedJudge();
    const lookup = async (list: string[]) => new Map(list.map((id) => [id, { email: `${id.slice(0, 4)}@example.test`, lastSignInAt: id === ids.judge1 ? null : "2026-11-06T10:00:00Z" }]));
    const out = (await loadJudges(client("admin"), lookup))!;
    expect(out.emailsKnown).toBe(true);
    const j1 = out.rows.find((r) => r.id === ids.judge1)!;
    expect(j1).toMatchObject({ assigned: 1, final: 0, drafts: 0, progress: 0, status: "invited" });
    expect(out.rows.find((r) => r.id === ids.judge2)).toMatchObject({ assigned: 0, progress: null, status: "active" });
  });

  it("without the secret key the list still works from profiles, and says e-mail addresses are unknown", async () => {
    await assignedJudge();
    const out = (await loadJudges(client("admin"), null))!;
    expect(out.emailsKnown).toBe(false);
    expect(out.rows.every((r) => r.email === null && r.status === "active")).toBe(true);
  });

  it("only an administrator can switch a judge off or on; a judge, a parent and an anonymous caller change nothing", async () => {
    await assignedJudge();
    const off = "update public.judge_profiles set active = false where user_id = $1 returning user_id";
    expect(await q(db(), "judge1", off, [ids.judge2])).toEqual([]);
    expect(await q(db(), "judge2", off, [ids.judge2])).toEqual([]); // not even their own profile
    expect(await q(db(), "parentA", off, [ids.judge2]).catch(() => [])).toEqual([]);
    expect((await q<{ user_id: string }>(db(), "admin", off, [ids.judge2])).map((r) => r.user_id)).toEqual([ids.judge2]);
    expect((await q<{ active: boolean }>(db(), "superuser", "select active from public.judge_profiles where user_id = $1", [ids.judge2]))[0]!.active).toBe(false);
  });

  it("a deactivated judge immediately loses every entry; reactivating brings them back; scores are kept", async () => {
    await assignedJudge();
    expect(await q(db(), "judge1", "select entry_id from public.judge_entries")).toHaveLength(1);
    await q(db(), "admin", "update public.judge_profiles set active = false where user_id = $1", [ids.judge1]);
    expect(await q(db(), "judge1", "select entry_id from public.judge_entries")).toEqual([]);
    await q(db(), "admin", "update public.judge_profiles set active = true where user_id = $1", [ids.judge1]);
    expect(await q(db(), "judge1", "select entry_id from public.judge_entries")).toHaveLength(1);
  });

  it("the provisioning inserts the invitation code uses work for an administrator, and are refused for a judge, a parent and a stranger", async () => {
    const ins = "insert into public.user_roles (user_id, role) values ($1, 'judge')";
    for (const who of ["judge1", "parentA", "stranger"] as const) {
      await actAs(db(), who);
      await db().exec("savepoint p");
      await expect(db().query(ins, [ids.stranger])).rejects.toMatchObject({ code: "42501" });
      await db().exec("rollback to savepoint p");
    }
    await q(db(), "admin", ins, [ids.stranger]);
    await q(db(), "admin", "insert into public.judge_profiles (user_id, display_name, active) values ($1, 'New Judge', true)", [ids.stranger]);
    const out = (await loadJudges(client("admin"), null))!;
    expect(out.rows.find((r) => r.id === ids.stranger)).toMatchObject({ name: "New Judge", assigned: 0 });
    // a parent's role cannot be granted by a judge, and an administrator role cannot be granted at all through the invitation path (judge only)
    expect(await q(db(), "superuser", "select role from public.user_roles where user_id = $1", [ids.stranger])).toEqual([{ role: "judge" }]);
  });
  // ---- manual judge accounts (lib/staff/provisioning.ts): the database side of the same steps, as the administrator's own session ----
  const NEW = ids.stranger;
  const roleSql = "insert into public.user_roles (user_id, role) values ($1, 'judge')";
  const profileSql = "insert into public.judge_profiles (user_id, display_name, active) values ($1, 'Manual Judge', false)";

  async function provisionManually() {
    await q(db(), "admin", roleSql, [NEW]);
    await q(db(), "admin", profileSql, [NEW]);
  }

  it("manual provisioning: the profile is inserted OFF, so the new judge can do nothing until the very last step switches it on", async () => {
    const s = await assignedJudge();
    await provisionManually();
    // inactive: the judge is nobody. Even an assignment made by an administrator shows nothing, because the view requires an active judge.
    await actAs(db(), "superuser");
    await db().query("update public.judge_profiles set active = true where user_id = $1", [NEW]); // assign needs an active judge ...
    await db().query("insert into public.judge_assignments (judge_id, submission_id) values ($1,$2)", [NEW, s.done]);
    await db().query("update public.judge_profiles set active = false where user_id = $1", [NEW]); // ... then back to the state before activation
    expect(await q(db(), "stranger", "select entry_id from public.judge_entries")).toEqual([]);
    await q(db(), "admin", "update public.judge_profiles set active = true where user_id = $1", [NEW]);
    expect(await q(db(), "stranger", "select entry_id from public.judge_entries")).toHaveLength(1);
  });

  it("manual provisioning: a profile cannot exist without the judge role, so the role must come first and an undo must remove the profile first", async () => {
    await actAs(db(), "admin");
    await db().exec("savepoint p");
    await expect(db().query(profileSql, [NEW])).rejects.toMatchObject({ code: "23503" });
    await db().exec("rollback to savepoint p");
    await provisionManually();
    // the undo path, newest first, as the administrator: nothing is left behind
    expect((await q(db(), "admin", "delete from public.judge_profiles where user_id = $1 returning user_id", [NEW])).length).toBe(1);
    expect((await q(db(), "admin", "delete from public.user_roles where user_id = $1 returning user_id", [NEW])).length).toBe(1);
    expect(await q(db(), "superuser", "select 1 from public.user_roles where user_id = $1", [NEW])).toEqual([]);
    expect(await q(db(), "superuser", "select 1 from public.judge_profiles where user_id = $1", [NEW])).toEqual([]);
  });

  it("manual provisioning is audited with the administrator as actor and no personal data or password in the details", async () => {
    await provisionManually();
    await q(db(), "admin", "update public.judge_profiles set active = true where user_id = $1", [NEW]);
    const rows = await q<{ actor: string; action: string; table_name: string; row_id: string; details: unknown }>(
      db(),
      "admin",
      "select actor, action, table_name, row_id, details from public.audit_log where row_id = $1 order by id",
      [NEW],
    );
    expect(rows.map((r) => `${r.action}:${r.table_name}`)).toEqual(["INSERT:user_roles", "INSERT:judge_profiles", "UPDATE:judge_profiles"]);
    expect(rows.every((r) => r.actor === ids.admin)).toBe(true);
    const text = JSON.stringify(rows.map((r) => r.details));
    expect(text).not.toMatch(/Manual Judge|password|@/); // names, e-mails and passwords never enter the audit log
    expect(rows[2]!.details).toMatchObject({ old: { active: false }, new: { active: true } });
  });

  it("manual provisioning is refused for everyone but an administrator, at every step", async () => {
    for (const who of ["judge1", "parentA", "stranger", "anon"] as const) {
      for (const sql of [roleSql, profileSql]) {
        await actAs(db(), who);
        await db().exec("savepoint p");
        await expect(db().query(sql, [NEW])).rejects.toMatchObject({ code: "42501" });
        await db().exec("rollback to savepoint p");
      }
    }
    expect(await q(db(), "superuser", "select 1 from public.user_roles where user_id = $1", [NEW])).toEqual([]);
  });

  it("a newly provisioned judge sees no parent or child information: no submissions, and the judge view has no personal columns", async () => {
    const s = await assignedJudge();
    await provisionManually();
    await q(db(), "admin", "update public.judge_profiles set active = true where user_id = $1", [NEW]);
    await actAs(db(), "superuser");
    await db().query("insert into public.judge_assignments (judge_id, submission_id) values ($1,$2)", [NEW, s.done]);
    expect(await q(db(), "stranger", "select id from public.submissions")).toEqual([]);
    const entries = await q<Record<string, unknown>>(db(), "stranger", "select * from public.judge_entries");
    expect(entries).toHaveLength(1);
    expect(Object.keys(entries[0]!).filter((k) => /parent|child|email|mobile|name_of|owner/i.test(k))).toEqual([]);
  });
});
