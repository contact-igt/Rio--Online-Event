import { describe, expect, it, vi } from "vitest";
import { inspectVideo } from "../../../website/lib/submit/inspect";
import { mintPlayback } from "../../../admin/lib/judging/playback";
import { saveScore, type ScoreDb } from "../../../admin/lib/judging/scoring";
import { confirmWinner, type WinnerDb } from "../../../admin/lib/judging/winners";
import { finalizeEntry, type FinalizeDb, type FinalizeDeps } from "../../../website/lib/submit/service";
import { actAs, ids, setupDb, uploadVerified, type Who } from "./helpers";

// THE WHOLE JOURNEY on the real migrations (PGlite) with the REAL application services and a fake private bucket:
//   parent registers (RLS) -> video uploaded and verified -> final submission (HeadObject re-check + container inspection)
//   -> admin assigns judge -> judge sees the anonymous entry and gets a short-lived playback link -> judge scores
//   -> admin ranks, flags the tie and confirms winners -> results stay private.
// What this does NOT prove: the real Supabase Auth/PostgREST layer, real R2, the Next.js pages in a browser, or real phone videos.

const db = setupDb();
const EVENT = 2; // ages 5 to 8

// --- a tiny valid MP4 (ftyp + moov(mvhd 45 s, video track) + mdat), large enough for the 100 KB upload minimum ---
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const text = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const be = (n: number, len: number) => Uint8Array.from({ length: len }, (_, i) => Math.floor(n / 256 ** (len - 1 - i)) % 256);
const box = (type: string, ...body: Uint8Array[]) => {
  const payload = cat(...body);
  return cat(be(8 + payload.length, 4), text(type), payload);
};
const mp4 = (seconds: number) =>
  cat(
    box("ftyp", text("isom"), be(0, 4), text("isom")),
    box("moov", box("mvhd", Uint8Array.of(0, 0, 0, 0), be(0, 4), be(0, 4), be(1000, 4), be(seconds * 1000, 4), new Uint8Array(80)), box("trak", box("mdia", box("hdlr", new Uint8Array(8), text("vide"), new Uint8Array(12))))),
    box("mdat", new Uint8Array(150_000)),
  );

class FakeBucket {
  objects = new Map<string, { bytes: Uint8Array; type: string; etag: string }>();
  heads = 0;
  signed: { key: string; expiresInSeconds: number }[] = [];
  store = {
    head: async (key: string) => {
      this.heads++;
      const o = this.objects.get(key);
      return o ? { bytes: o.bytes.length, contentType: o.type, etag: o.etag } : null;
    },
    readRange: async (key: string, start: number, end: number) => this.objects.get(key)!.bytes.subarray(start, end + 1),
    presignGet: async (key: string, o: { expiresInSeconds: number }) => {
      this.signed.push({ key, expiresInSeconds: o.expiresInSeconds });
      return `https://r2.test/${key}?X-Amz-Expires=${o.expiresInSeconds}&sig=fake`;
    },
  };
}

// Run one statement as a role, in a savepoint so an expected refusal does not poison the test's transaction.
async function run<T>(who: Who, sql: string, params: unknown[] = []): Promise<T[]> {
  await actAs(db(), who);
  await db().exec("savepoint step");
  try {
    const rows = (await db().query<T>(sql, params)).rows;
    await db().exec("release savepoint step");
    return rows;
  } catch (e) {
    await db().exec("rollback to savepoint step");
    throw e;
  }
}

const finalizeDb: FinalizeDb = {
  async check(owner, submission) {
    const [r] = await run<{ upload_id: string; bytes: string; content_type: string; etag: string; event_id: number; consent_version: string; already: boolean }>("service", "select * from public.check_finalize($1,$2)", [owner, submission]);
    return { uploadId: r!.upload_id, bytes: Number(r!.bytes), type: r!.content_type, etag: r!.etag, eventId: r!.event_id, consentVersion: r!.consent_version, already: r!.already };
  },
  async finalize(owner, submission, upload, bytes, type, etag) {
    const [r] = await run<{ f: "finalized" | "already_finalized" }>("service", "select public.finalize_verified_submission($1,$2,$3,$4,$5,$6) as f", [owner, submission, upload, bytes, type, etag]);
    return r!.f;
  },
};
const scoreDbFor = (who: Who): ScoreDb => ({
  async find(entryId) {
    const r = await run<{ id: string; status: "draft" | "final" }>(who, "select id, status from public.scores where submission_id = $1", [entryId]);
    return r[0] ?? null;
  },
  async insert(row) {
    await run(who, "insert into public.scores (submission_id, marks, comments, status) values ($1,$2,$3,$4)", [row.submissionId, row.marks, row.comments, row.status]);
  },
  async update(id, row) {
    return (await run(who, "update public.scores set marks = $2, comments = $3, status = $4 where id = $1 returning id", [id, row.marks, row.comments, row.status])).length;
  },
});
const winnerDb: WinnerDb = {
  async eventScoring(eventId) {
    const subs = await run<{ id: string }>("admin", "select id from public.submissions where event_id = $1 and status = 'finalized'", [eventId]);
    const idList = subs.map((s) => s.id);
    const a = await run<{ judge_id: string; submission_id: string }>("admin", "select judge_id, submission_id from public.judge_assignments where submission_id = any($1::uuid[])", [idList]);
    const s = await run<{ judge_id: string; submission_id: string; marks: string | null; status: "draft" | "final" }>("admin", "select judge_id, submission_id, marks, status from public.scores where submission_id = any($1::uuid[])", [idList]);
    return {
      finalizedIds: idList,
      assignments: a.map((r) => ({ judgeId: r.judge_id, submissionId: r.submission_id })),
      scores: s.map((r) => ({ judgeId: r.judge_id, submissionId: r.submission_id, marks: r.marks === null ? null : Number(r.marks), status: r.status })),
    };
  },
  async insert(row) {
    await run("admin", "insert into public.winners (event_id, submission_id, rank, award_label, display_name) values ($1,$2,$3,$4,$5)", [row.eventId, row.submissionId, row.rank, row.awardLabel, row.displayName]);
  },
  async remove(id) {
    return (await run("admin", "delete from public.winners where id = $1 returning id", [id])).length;
  },
};

/** Parent registers through row level security, uploads (verified), and submits through the real finalization service. */
async function submitEntry(parent: Who, owner: string, child: string, mobile: string, bucket: FakeBucket, seconds = 45) {
  const [row] = await run<{ id: string; status: string; owner_id: string }>(parent, "insert into public.submissions (event_id, child_name, child_age, parent_name, parent_email, parent_mobile, consent_version) values ($1,$2,6,'Parent','p@example.test',$3,'v1') returning id, status, owner_id", [EVENT, child, mobile]);
  expect(row).toMatchObject({ status: "draft", owner_id: owner });
  const video = mp4(seconds);
  const v = await uploadVerified(db(), owner, row!.id, { bytes: video.length, type: "video/mp4", etag: `"etag-${child}"` });
  bucket.objects.set(`videos/${v.upload}`, { bytes: video, type: "video/mp4", etag: v.etag });
  const deps: FinalizeDeps = {
    store: bucket.store,
    db: finalizeDb,
    consentKnown: (version) => version === "v1",
    inspect: (key, type, size) => inspectVideo(type, size, (a, b) => bucket.store.readRange(key, a, b)),
  };
  const result = await finalizeEntry(deps, { ownerId: owner, submissionId: row!.id, eventId: EVENT });
  return { id: row!.id, upload: v.upload, result };
}

describe("the competition journey, end to end", () => {
  it("parent registers, uploads and submits; admin assigns; judge plays and scores; admin ranks and confirms; results stay private", async () => {
    const bucket = new FakeBucket();

    // 1-3. registration, verified upload, final submission (with the container inspection of the stored file)
    const a = await submitEntry("parentA", ids.parentA, "Asha", "9876500011", bucket);
    expect(a.result).toEqual({ ok: true, already: false });
    expect((await run<{ status: string }>("superuser", "select status from public.submissions where id = $1", [a.id]))[0]!.status).toBe("finalized");

    // another parent cannot see it, and a judge gets no row from submissions at all
    expect(await run("parentB", "select id from public.submissions where id = $1", [a.id])).toEqual([]);
    expect(await run("judge1", "select id from public.submissions")).toEqual([]);

    // 4. admin assigns judge1 (and judge2) to the competition
    expect((await run<{ n: number }>("admin", "select public.assign_judge_to_event($1, $2::smallint) as n", [ids.judge1, EVENT]))[0]!.n).toBe(1);
    expect((await run<{ n: number }>("admin", "select public.assign_judge_to_event($1, $2::smallint) as n", [ids.judge2, EVENT]))[0]!.n).toBe(1);

    // 5. the judge sees only the anonymous entry, and gets a five-minute link signed for the private object
    const seen = await run<Record<string, unknown>>("judge1", "select * from public.judge_entries");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ entry_id: a.id, event_id: EVENT });
    expect(JSON.stringify(seen)).not.toMatch(/Asha|9876500011|example\.test/);
    const authorize = async (judge: string, submission: string) => (await run<{ v: string }>("service", "select public.authorize_playback($1,$2) as v", [judge, submission]))[0]!.v;
    const link = await mintPlayback({ authorize, store: bucket.store }, { judgeId: ids.judge1, entryId: a.id });
    expect(link).toMatchObject({ ok: true, expiresInSeconds: 300 });
    expect(bucket.signed).toEqual([{ key: `videos/${a.upload}`, expiresInSeconds: 300 }]);
    expect((await run("superuser", "select 1 from public.audit_log where action = 'PLAYBACK_URL' and actor = $1", [ids.judge1])).length).toBe(1);
    // a judge who is not assigned (judge3 does not exist) or a parent gets nothing signed
    const before = bucket.signed.length;
    expect(await mintPlayback({ authorize, store: bucket.store }, { judgeId: ids.parentA, entryId: a.id })).toEqual({ ok: false, code: "notFound" });
    expect(bucket.signed.length).toBe(before);

    // 6. scoring: draft, then final; one row per judge; final is locked; an unassigned account cannot score
    const j1 = scoreDbFor("judge1");
    expect(await saveScore(j1, { entryId: a.id, marks: "70", comments: "", final: false })).toEqual({ ok: true, status: "draft" });
    expect(await saveScore(j1, { entryId: a.id, marks: "88.5", comments: "Clear and confident", final: true })).toEqual({ ok: true, status: "final" });
    expect(await saveScore(j1, { entryId: a.id, marks: "10", comments: "", final: false })).toEqual({ ok: false, code: "locked" });
    expect((await run<{ n: string }>("superuser", "select count(*)::int as n from public.scores where submission_id = $1 and judge_id = $2", [a.id, ids.judge1]))[0]!.n).toBe(1);
    expect(await saveScore(scoreDbFor("stranger"), { entryId: a.id, marks: "99", comments: "", final: false })).toEqual({ ok: false, code: "notAllowed" });
    expect(await saveScore(scoreDbFor("parentA"), { entryId: a.id, marks: "99", comments: "", final: false })).toEqual({ ok: false, code: "notAllowed" });

    // 7. winners: not until every assigned judge has finalized
    expect(await confirmWinner(winnerDb, EVENT, { submissionId: a.id, rank: "1", displayName: "Asha" })).toEqual({ ok: false, code: "incomplete" });
    expect(await saveScore(scoreDbFor("judge2"), { entryId: a.id, marks: "88.5", comments: "", final: true })).toEqual({ ok: true, status: "final" });

    // a second entry that ties with the first
    const b = await submitEntry("parentB", ids.parentB, "Bala", "9876500012", bucket);
    expect(b.result).toEqual({ ok: true, already: false });
    await run("admin", "select public.assign_judge_to_event($1, $2::smallint)", [ids.judge1, EVENT]);
    await run("admin", "select public.assign_judge_to_event($1, $2::smallint)", [ids.judge2, EVENT]);
    for (const who of ["judge1", "judge2"] as const) expect(await saveScore(scoreDbFor(who), { entryId: b.id, marks: "88.5", comments: "", final: true })).toEqual({ ok: true, status: "final" });

    // the tie is flagged for the administrator, never resolved automatically
    expect(await confirmWinner(winnerDb, EVENT, { submissionId: a.id, rank: "1", displayName: "Asha" })).toEqual({ ok: false, code: "tieNeedsDecision" });
    expect(await confirmWinner(winnerDb, EVENT, { submissionId: a.id, rank: "1", displayName: "Asha", acknowledgeTie: true })).toEqual({ ok: true });
    expect(await confirmWinner(winnerDb, EVENT, { submissionId: b.id, rank: "1", displayName: "Bala", acknowledgeTie: true })).toEqual({ ok: false, code: "rankTaken" });
    expect(await confirmWinner(winnerDb, EVENT, { submissionId: b.id, rank: "2", displayName: "Bala", acknowledgeTie: true })).toEqual({ ok: true });

    // 8. nothing is published: not for the public, parents, judges, and the winners table itself is admin-only
    for (const who of ["anon", "parentA", "parentB", "judge1", "admin"] as const) {
      expect(await run(who, "select * from public.published_winners"), who).toEqual([]);
    }
    for (const who of ["anon", "parentA", "judge1"] as const) {
      const attempt = await run(who, "select * from public.winners").catch(() => []);
      expect(attempt, who).toEqual([]);
    }
    expect((await run<{ results_publish_at: string | null }>("anon", "select results_publish_at from public.event_settings"))[0]!.results_publish_at).toBeNull();
    // even a scheduled time in the future releases nothing yet
    await run("admin", "update public.event_settings set results_publish_at = '2099-01-01T00:00:00+05:30'");
    for (const who of ["anon", "parentA", "judge1"] as const) expect(await run(who, "select * from public.published_winners"), who).toEqual([]);

    // every sensitive step left an audit trail without personal data
    const audit = await run<{ action: string; table_name: string }>("superuser", "select action, table_name, details from public.audit_log");
    expect(audit.some((r) => r.table_name === "winners")).toBe(true);
    expect(audit.some((r) => r.table_name === "judge_assignments")).toBe(true);
    expect(audit.some((r) => r.action === "PLAYBACK_URL")).toBe(true);
    expect(JSON.stringify(audit)).not.toMatch(/Asha|Bala|9876500011|9876500012|example\.test/);
  });

  it("final submission refuses a stored file that is not a video, and one outside 30 to 90 seconds, and nothing is finalized", async () => {
    const bucket = new FakeBucket();
    const tooShort = await submitEntry("parentA", ids.parentA, "Short", "9876500021", bucket, 8);
    expect(tooShort.result).toEqual({ ok: false, code: "videoDuration" });
    // replace the verified object's bytes with text of the same size and the same ETag: the container check still refuses it
    const [row] = await run<{ id: string }>("parentB", "insert into public.submissions (event_id, child_name, child_age, parent_name, parent_email, parent_mobile, consent_version) values ($1,'Fake',6,'P','p@example.test','9876500022','v1') returning id", [EVENT]);
    const html = new Uint8Array(150_000).fill(60);
    const v = await uploadVerified(db(), ids.parentB, row!.id, { bytes: html.length, type: "video/mp4", etag: '"etag-fake"' });
    bucket.objects.set(`videos/${v.upload}`, { bytes: html, type: "video/mp4", etag: v.etag });
    const deps: FinalizeDeps = { store: bucket.store, db: finalizeDb, consentKnown: () => true, inspect: (key, type, size) => inspectVideo(type, size, (a, b) => bucket.store.readRange(key, a, b)) };
    expect(await finalizeEntry(deps, { ownerId: ids.parentB, submissionId: row!.id, eventId: EVENT })).toEqual({ ok: false, code: "videoInvalid" });
    const statuses = await run<{ status: string }>("superuser", "select status from public.submissions where id = any($1::uuid[])", [[tooShort.id, row!.id]]);
    expect(statuses.every((s) => s.status === "uploaded")).toBe(true);
    void vi;
  });
});
