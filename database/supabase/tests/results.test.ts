import { describe, expect, it } from "vitest";
import { actAs, fails, ids, insertDraft, PG, q, setupDb, uploadVerified, type Who } from "./helpers";

// The public results view on the real migrations: hidden until an administrator schedules publication AND the time has passed,
// and then only four columns with no personal data. The "publication time must not be before 14 November 2026" rule is a CHECK, so the
// positive case drops it inside the test's rolled-back transaction (the only way to put a time in the past while today is earlier).

const db = setupDb();

async function winner(rank: number, name: string, event = 2, label: string | null = null) {
  const id = await insertDraft(db(), { owner: ids.parentA, childName: `Child${rank}${name}`, event, age: event === 4 ? 9 : 6, mobile: `98765000${rank}${event}` });
  const v = await uploadVerified(db(), ids.parentA, id);
  await actAs(db(), "service");
  await db().query("select public.finalize_verified_submission($1,$2,$3,$4,$5,$6)", [ids.parentA, id, v.upload, v.bytes, v.type, v.etag]);
  await actAs(db(), "admin"); // the database stamps who approved from the signed-in administrator
  await db().query("insert into public.winners (event_id, submission_id, rank, award_label, display_name) values ($1,$2,$3,$4,$5)", [event, id, rank, label, name]);
  return id;
}
async function publishInThePast() {
  await actAs(db(), "superuser");
  const c = await db().query<{ conname: string }>("select conname from pg_constraint where conrelid = 'public.event_settings'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%results_publish_at%'");
  for (const row of c.rows) await db().exec(`alter table public.event_settings drop constraint "${row.conname}"`);
  await db().exec("update public.event_settings set results_publish_at = now() - interval '1 minute'");
}
const WHO: Who[] = ["anon", "parentA", "parentB", "judge1", "admin"];

describe("published_winners", () => {
  it("exposes exactly four public columns: no entry, owner, approver or time", async () => {
    await actAs(db(), "superuser");
    const cols = await db().query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'published_winners' order by ordinal_position");
    expect(cols.rows.map((c) => c.column_name)).toEqual(["event_id", "rank", "award_label", "display_name"]);
  });

  it("is empty for everyone while publication is not scheduled, even with confirmed winners", async () => {
    await winner(1, "Asha");
    await winner(2, "Bala");
    for (const who of WHO) expect(await q(db(), who, "select * from public.published_winners"), who).toEqual([]);
  });

  it("is empty for everyone while publication is scheduled for the future", async () => {
    await winner(1, "Asha");
    await actAs(db(), "admin");
    await db().query("update public.event_settings set results_publish_at = '2099-01-01T00:00:00+05:30'");
    for (const who of WHO) expect(await q(db(), who, "select * from public.published_winners"), who).toEqual([]);
  });

  it("an administrator cannot schedule publication before 14 November 2026, and nobody else can schedule at all", async () => {
    expect((await fails(db(), "admin", "update public.event_settings set results_publish_at = '2026-11-13T23:59:00+05:30'")).code).toBe(PG.checkViolation);
    for (const who of ["anon", "parentA", "judge1"] as const) {
      await actAs(db(), who);
      await db().exec("savepoint try_update");
      let changed = -1;
      let code: string | undefined;
      try {
        changed = (await db().query("update public.event_settings set results_publish_at = '2099-01-01T00:00:00+05:30' returning 1")).rows.length;
      } catch (e) {
        code = (e as { code?: string }).code;
        await db().exec("rollback to savepoint try_update");
      }
      expect(code === PG.insufficientPrivilege || changed === 0, who).toBe(true);
    }
  });

  it("once the time has passed, everyone sees the confirmed winners, and only their public fields", async () => {
    await winner(1, "Asha", 2, "First prize");
    await winner(2, "Bala", 2);
    await winner(1, "Chitra", 4);
    await publishInThePast();
    for (const who of WHO) {
      const rows = await q<{ event_id: number; rank: number; award_label: string | null; display_name: string }>(db(), who, "select * from public.published_winners order by event_id, rank");
      expect(rows.map((r) => [r.event_id, r.rank, r.display_name, r.award_label]), who).toEqual([[2, 1, "Asha", "First prize"], [2, 2, "Bala", null], [4, 1, "Chitra", null]]);
      expect(Object.keys(rows[0]!).sort(), who).toEqual(["award_label", "display_name", "event_id", "rank"]);
      expect(JSON.stringify(rows), who).not.toMatch(/Child|98765|example\.test/);
    }
  });

  it("an entry that is not a confirmed winner never appears, and removing a winner removes it at once", async () => {
    await winner(1, "Asha");
    const second = await winner(2, "Bala");
    await publishInThePast();
    await insertDraft(db(), { owner: ids.parentB, childName: "Not a winner", event: 2, mobile: "9876500099" });
    expect((await q(db(), "anon", "select * from public.published_winners")).length).toBe(2);
    await actAs(db(), "admin");
    await db().query("delete from public.winners where submission_id = $1", [second]);
    expect((await q(db(), "anon", "select display_name from public.published_winners")).map((r) => (r as { display_name: string }).display_name)).toEqual(["Asha"]);
  });

  it("the winners table itself stays closed to the public, parents and judges", async () => {
    await winner(1, "Asha");
    await publishInThePast();
    expect((await fails(db(), "anon", "select * from public.winners")).code).toBe(PG.insufficientPrivilege);
    for (const who of ["parentA", "judge1"] as const) expect(await q(db(), who, "select * from public.winners"), who).toEqual([]);
  });
});
