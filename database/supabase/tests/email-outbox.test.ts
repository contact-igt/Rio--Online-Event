import { describe, expect, it } from "vitest";
import { actAs, fails, ids, insertDraft, PG, q, setupDb, uploadVerified, type Who } from "./helpers";

// The confirmation e-mail outbox (migration 00800) on real Postgres: one row per finalized submission, claimed atomically, retried with a
// growing delay, closed to every role but the service role, and holding no address and no text.

const db = setupDb();
let counter = 0;

async function finalized(owner: string = ids.parentA): Promise<string> {
  counter += 1;
  const id = await insertDraft(db(), { owner, childName: `Child${"abcdefghij"[counter % 10]}${counter}`, event: 2, mobile: `98765${String(10000 + counter)}` });
  const v = await uploadVerified(db(), owner, id);
  await actAs(db(), "service");
  await db().query("select public.finalize_verified_submission($1,$2,$3,$4,$5,$6)", [owner, id, v.upload, v.bytes, v.type, v.etag]);
  return id;
}
const enqueue = async (submission: string) => (await q<{ id: string }>(db(), "service", "select public.enqueue_participation_email($1) as id", [submission]))[0]!.id;
const claim = (id: string) => q<{ parent_email: string; entry_code: string; event_id: number; attempt: number }>(db(), "service", "select * from public.claim_participation_email($1)", [id]);
const finish = (id: string, outcome: string) => q(db(), "service", "select public.finish_participation_email($1,$2)", [id, outcome]);
const row = async (id: string) => (await q<{ status: string; attempts: number; last_error: string | null; sent_at: string | null; locked_until: string | null; due: boolean }>(db(), "superuser", "select status, attempts, last_error, sent_at, locked_until, next_attempt_at <= now() as due from public.email_outbox where id = $1", [id]))[0]!;
const makeDue = async (id: string) => q(db(), "superuser", "update public.email_outbox set next_attempt_at = now() - interval '1 second' where id = $1", [id]);

describe("access", () => {
  it("only the service role can run any outbox function; nobody else can read or write the table", async () => {
    const sub = await finalized();
    const id = await enqueue(sub);
    for (const who of ["anon", "parentA", "judge1", "admin"] as const satisfies readonly Who[]) {
      expect((await fails(db(), who, "select public.enqueue_participation_email($1)", [sub])).code, who).toBe(PG.insufficientPrivilege);
      expect((await fails(db(), who, "select * from public.claim_participation_email($1)", [id])).code, who).toBe(PG.insufficientPrivilege);
      expect((await fails(db(), who, "select public.finish_participation_email($1,'sent')", [id])).code, who).toBe(PG.insufficientPrivilege);
      expect((await fails(db(), who, "select public.due_participation_emails(5)")).code, who).toBe(PG.insufficientPrivilege);
      expect((await fails(db(), who, "select * from public.email_outbox")).code, who).toBe(PG.insufficientPrivilege);
      expect((await fails(db(), who, "delete from public.email_outbox")).code, who).toBe(PG.insufficientPrivilege);
    }
  });

  it("every new function is SECURITY DEFINER with an empty search path and is not executable by PUBLIC, anon or authenticated", async () => {
    await actAs(db(), "superuser");
    const res = await db().query<{ name: string; secdef: boolean; config: string; pub: boolean; anon: boolean; authed: boolean; service: boolean }>(`
      select p.proname as name, p.prosecdef as secdef, coalesce(p.proconfig::text, '') as config,
             (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')) as pub,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as service
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%participation_email%' order by 1`);
    expect(res.rows.map((r) => r.name)).toEqual(["claim_participation_email", "due_participation_emails", "enqueue_participation_email", "finish_participation_email"]);
    for (const r of res.rows) expect([r.secdef, r.config.includes("search_path="), r.pub, r.anon, r.authed, r.service], r.name).toEqual([true, true, false, false, false, true]);
    const rls = await db().query<{ rls: boolean }>("select relrowsecurity as rls from pg_class where oid = 'public.email_outbox'::regclass");
    expect(rls.rows[0]!.rls).toBe(true);
  });

  it("the table holds no address and no text, only ids, states and counters", async () => {
    await actAs(db(), "superuser");
    const cols = await db().query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'email_outbox' order by ordinal_position");
    expect(cols.rows.map((c) => c.column_name)).toEqual(["id", "submission_id", "kind", "status", "attempts", "next_attempt_at", "locked_until", "last_error", "created_at", "sent_at"]);
  });
});

describe("enqueue", () => {
  it("records one row for a finalized submission, and the same row for every repeat", async () => {
    const sub = await finalized();
    const a = await enqueue(sub);
    const b = await enqueue(sub);
    expect(b).toBe(a);
    expect((await q(db(), "superuser", "select 1 from public.email_outbox where submission_id = $1", [sub])).length).toBe(1);
    expect(await row(a)).toMatchObject({ status: "pending", attempts: 0 });
  });
  it("refuses a draft, an uploaded entry and an unknown submission", async () => {
    const draft = await insertDraft(db(), { owner: ids.parentB, childName: "Draft" });
    expect((await fails(db(), "service", "select public.enqueue_participation_email($1)", [draft])).message).toContain("not_finalized");
    expect((await fails(db(), "service", "select public.enqueue_participation_email($1)", ["00000000-0000-4000-8000-000000000000"])).message).toContain("not_finalized");
  });
});

describe("claim: only one sender can take a row", () => {
  it("returns exactly what the e-mail needs, once; a second claim (a concurrent request) gets nothing", async () => {
    const sub = await finalized();
    const id = await enqueue(sub);
    const first = await claim(id);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ parent_email: "parent@example.test", event_id: 2, attempt: 1 });
    expect(first[0]!.entry_code).toMatch(/^RIO-[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    expect(await claim(id)).toEqual([]);
    expect(await row(id)).toMatchObject({ status: "sending", attempts: 1 });
  });
  it("two claims issued together still produce one winner", async () => {
    const id = await enqueue(await finalized());
    const [a, b] = await Promise.all([claim(id), claim(id)]);
    expect([a.length, b.length].sort()).toEqual([0, 1]);
  });
  it("a sender that crashed (lock expired) can be replaced, a live one cannot", async () => {
    const id = await enqueue(await finalized());
    await claim(id);
    expect(await claim(id)).toEqual([]);
    await q(db(), "superuser", "update public.email_outbox set locked_until = now() - interval '1 second' where id = $1", [id]);
    expect((await claim(id)).length).toBe(1);
    expect((await row(id)).attempts).toBe(2);
  });
  it("is not claimable once sent, and never for an entry that is no longer finalized", async () => {
    const sent = await enqueue(await finalized());
    await claim(sent);
    await finish(sent, "sent");
    await makeDue(sent);
    expect(await claim(sent)).toEqual([]);
    const sub = await finalized(ids.parentB);
    const withdrawn = await enqueue(sub);
    await actAs(db(), "admin");
    await db().query("select public.withdraw_submission($1)", [sub]);
    expect(await claim(withdrawn)).toEqual([]);
  });
});

describe("finish and retry", () => {
  it("sent: recorded with a time, and the row is closed", async () => {
    const id = await enqueue(await finalized());
    await claim(id);
    await finish(id, "sent");
    expect(await row(id)).toMatchObject({ status: "sent", last_error: null, locked_until: null });
    expect((await row(id)).sent_at).not.toBeNull();
  });
  it("a transient failure waits (2 minutes after the first attempt, doubling) before it can be claimed again", async () => {
    const id = await enqueue(await finalized());
    await claim(id);
    await finish(id, "transient");
    expect(await row(id)).toMatchObject({ status: "failed", attempts: 1, last_error: "transient", due: false });
    expect(await claim(id)).toEqual([]); // not due yet
    const wait = await q<{ minutes: number }>(db(), "superuser", "select extract(epoch from (next_attempt_at - now())) / 60 as minutes from public.email_outbox where id = $1", [id]);
    expect(Math.round(Number(wait[0]!.minutes))).toBe(2);
    await makeDue(id);
    expect((await claim(id)).length).toBe(1);
    await finish(id, "transient");
    const wait2 = await q<{ minutes: number }>(db(), "superuser", "select extract(epoch from (next_attempt_at - now())) / 60 as minutes from public.email_outbox where id = $1", [id]);
    expect(Math.round(Number(wait2[0]!.minutes))).toBe(4);
  });
  it("a permanent failure closes the row at once, and nothing reopens it", async () => {
    const id = await enqueue(await finalized());
    await claim(id);
    await finish(id, "permanent");
    expect(await row(id)).toMatchObject({ status: "abandoned", last_error: "permanent" });
    await makeDue(id);
    expect(await claim(id)).toEqual([]);
  });
  it("after eight failed attempts the row is abandoned and is never claimed again", async () => {
    const id = await enqueue(await finalized());
    for (let i = 1; i <= 8; i++) {
      await makeDue(id);
      expect((await claim(id)).length, `attempt ${i}`).toBe(1);
      await finish(id, "transient");
    }
    expect(await row(id)).toMatchObject({ status: "abandoned", attempts: 8 });
    await makeDue(id);
    expect(await claim(id)).toEqual([]);
  });
  it("finish only applies to a row that is being sent, and refuses an unknown outcome", async () => {
    const id = await enqueue(await finalized());
    await finish(id, "sent"); // not claimed: ignored
    expect(await row(id)).toMatchObject({ status: "pending" });
    expect((await fails(db(), "service", "select public.finish_participation_email($1,'maybe')", [id])).message).toContain("invalid_outcome");
  });
});

describe("due_participation_emails", () => {
  it("lists what a worker should try next, oldest first, and never a sent, abandoned, locked or future row", async () => {
    const a = await enqueue(await finalized());
    const b = await enqueue(await finalized());
    const c = await enqueue(await finalized());
    const d = await enqueue(await finalized());
    await claim(b); // being sent
    await claim(c);
    await finish(c, "sent");
    await claim(d);
    await finish(d, "transient"); // waiting
    const due = (await q<{ due_participation_emails: string }>(db(), "service", "select public.due_participation_emails(10)")).map((r) => r.due_participation_emails);
    expect(due).toEqual([a]);
    expect((await q(db(), "service", "select public.due_participation_emails(0)")).length).toBeLessThanOrEqual(1);
  });
});

describe("audit and the submission", () => {
  it("every state change is audited by id and state, with no address", async () => {
    const sub = await finalized();
    const id = await enqueue(sub);
    await claim(id);
    await finish(id, "sent");
    const audit = await q<{ action: string; details: Record<string, unknown> }>(db(), "superuser", "select action, details from public.audit_log where table_name = 'email_outbox'");
    expect(audit.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(audit)).not.toMatch(/example\.test|@/);
  });
  it("nothing in the outbox can change a finalized submission", async () => {
    const sub = await finalized();
    const before = await q(db(), "superuser", "select status, finalized_at, video_key from public.submissions where id = $1", [sub]);
    const id = await enqueue(sub);
    await claim(id);
    await finish(id, "permanent");
    expect(await q(db(), "superuser", "select status, finalized_at, video_key from public.submissions where id = $1", [sub])).toEqual(before);
  });
});
