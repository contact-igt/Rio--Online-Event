// LIVE video-upload integration test: a real parent session, the real app, the real dev Supabase project and the real dev R2
// bucket. NOT part of `npm run test:e2e`. NEVER run without a separate approval of this exact plan. Run it only as
//
//   RIO_LIVE_CONFIRM=<dev project ref> RIO_LIVE_R2_CONFIRM=<dev bucket name> npm run test:e2e:live:upload
//
// What it does to the dev project (everything tagged with a unique run id and removed afterwards):
//   * creates 2 dummy auth users (<run>-a@example.test, <run>-b@example.test)
//   * TEMPORARILY OPENS REGISTRATION for 30 minutes (exact original settings restored afterwards)
//   * registers ONE dummy child through the real form, then uploads ONE synthetic file through the real upload panel
//   * a few more authorizations for the same entry (negative cases), each tracked
// What it does to the bucket: the browser PUTs one object to pending/<id>; the server copies it to videos/<id>; negative cases
// may PUT more objects under pending/<id>. It deletes ONLY the exact keys pending/<id> and videos/<id> of ids this run created
// (cleanup is computed by planCleanup and each key is re-checked with isTrackedKey), and reports anything else it finds.
//
// Uploads are switched on only for the web server this run starts (see playwright.upload.config.ts), never in .env.local.
// Nothing here prints a URL, key, email or code; assertions compare booleans so a failure message cannot carry them.
// The payload is a GENUINE 31-second WebM recorded in the test's own Chrome with MediaRecorder (an animated colour with a frame
// counter; no person, child, voice or personal data). Before anything hosted is touched it is loaded back into a <video> element
// to prove it decodes, has the expected length and picture size, and really plays.
//
// IMPORTANT: the server verifies the stored object's SIZE, TYPE header and ETag with HeadObject. It does not inspect the media
// (no probe of the container, codec or duration exists), so a passing run is NOT evidence that the server validates media.

import { createHash } from "node:crypto";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { expect, test } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createR2Client, createR2Store, readR2Config, type ObjectStore } from "../lib/storage/object-store";
import { finishUpload, startUpload, type UploadDeps } from "../lib/upload/service";
import { createUploadDb } from "../lib/upload/server";
import { authHealth, isTrackedKey, isUploadId, keysFor, leaksSensitive, mediaProblems, planCleanup, stage, withTimeout, type MediaFacts } from "../scripts/live-upload";
import { generateWebm } from "./media";
import { createDummyUser, runId, serviceClient, signInThroughApp, target, userSession } from "./helpers";

const cfg = readR2Config()!;
const r2 = createR2Client(cfg);
const real: ObjectStore = createR2Store(cfg, r2); // used by the test's own checks and by cleanup
const service = serviceClient(); // provisioning, baseline and cleanup ONLY
const run = runId("m4au");
const A = { id: "", email: `${run}-a@example.test` };
const B = { id: "", email: `${run}-b@example.test` };
const EVENT = "kutti-pesalar";
const letters = (s: string) => s.replace(/[0-9]/g, "x");
const CHILD = letters(`Asha-${run}`);
const PARENT = letters(`Parent-${run}`);
const MOBILE = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const SETTINGS_COLUMNS = "submissions_open_at, submissions_close_at, current_consent_version, results_publish_at";
const SECRETS = [cfg.accountId, cfg.accessKeyId, cfg.secretAccessKey, cfg.bucket, A.email, B.email];
const RECORD_SECONDS = 31;
let MEDIA: Buffer; // the genuine WebM, generated first thing in beforeAll, before any hosted call
let FACTS: MediaFacts;

let baseline: { settings: Record<string, unknown>; submissions: number; uploads: number; keys: string[] } | null = null;
let aRest: SupabaseClient;
let bRest: SupabaseClient;
const tracked = new Set<string>(); // every upload id this run created, whatever happened to it
let draftId = "";
let firstId = "";
let firstPutUrl = "";
let firstEtag = "";

/** The service wrapped in counters, so the negative tests can prove that R2 was never contacted. */
const calls = { presign: 0, head: 0, copy: 0, remove: 0 };
const counted: ObjectStore = {
  presignPut: (...a) => (calls.presign++, real.presignPut(...a)),
  head: (...a) => (calls.head++, real.head(...a)),
  copy: (...a) => (calls.copy++, real.copy(...a)),
  remove: (...a) => (calls.remove++, real.remove(...a)),
};
const deps = (): UploadDeps => ({ store: counted, db: createUploadDb(service) });
const snapshot = () => ({ ...calls });
const meta = () => ({ type: "video/webm", bytes: MEDIA.length, seconds: Math.round(FACTS.duration) });

async function listAllKeys(): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  for (let page = 0; page < 20; page++) {
    const out = await r2.send(new ListObjectsV2Command({ Bucket: cfg.bucket, ContinuationToken: token }), { abortSignal: AbortSignal.timeout(30_000) });
    for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key);
    if (!out.IsTruncated) break;
    token = out.NextContinuationToken;
  }
  return keys;
}
const idFromUrl = (url: string): string => url.match(/\/pending\/([0-9a-f-]{36})(?:\?|$)/)?.[1] ?? "";
const submissionCount = async () => (await service.from("submissions").select("*", { count: "exact", head: true })).count ?? 0;
const uploadCount = async () => (await service.from("video_uploads").select("*", { count: "exact", head: true })).count ?? 0;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  // Provisioning is bounded and named. Every Supabase request has a 30 s timeout (helpers.ts) and every R2 listing too, so a stalled
  // network fails ONE stage quickly with its name, instead of running into the hook's overall limit. The limit itself is generous.
  test.setTimeout(360_000);

  // 0. the test video, BEFORE any Supabase or R2 call: if it is not real and playable, nothing hosted is touched
  const made = await stage("generate the test video", () => generateWebm(browser, RECORD_SECONDS));
  MEDIA = made.data;
  FACTS = made.facts;
  const gate = mediaProblems(FACTS, RECORD_SECONDS);
  if (gate.length > 0) throw new Error(`the generated test video is not acceptable: ${gate.join(", ")}`);
  test.info().annotations.push({ type: "media", description: `genuine ${FACTS.mime}, ${FACTS.duration.toFixed(1)} s, ${FACTS.width}x${FACTS.height}, ${FACTS.bytes} bytes, decoded and played in Chrome` });

  // 1. fail fast, before ANY write: is Supabase Auth answering at all? (one harmless GET of its public health endpoint)
  const health = await authHealth(target.url, target.publishableKey);
  if (health !== "healthy") throw new Error(`Supabase Auth is not answering (${health}); nothing was written. Check the network, then ask for a new run.`);

  // 2. read-only baselines
  const settings = await stage("read the settings baseline", async () => {
    const res = await service.from("event_settings").select(SETTINGS_COLUMNS).single();
    if (res.error) throw new Error("read failed");
    return res.data as Record<string, unknown>;
  });
  const keys = await stage("list the bucket baseline", () => listAllKeys());
  const submissions = await stage("count submissions", submissionCount);
  const uploads = await stage("count uploads", uploadCount);
  baseline = { settings, submissions, uploads, keys };

  // 3. writes, each stage named (the cleanup in afterAll knows about whatever was created so far)
  A.id = await stage("create parent A", () => createDummyUser(service, A.email));
  B.id = await stage("create parent B", () => createDummyUser(service, B.email));
  await stage("open the temporary registration window", async () => {
    const opened = await service
      .from("event_settings")
      .update({ submissions_open_at: new Date(Date.now() - 60_000).toISOString(), submissions_close_at: new Date(Date.now() + 30 * 60_000).toISOString(), current_consent_version: "v0-provisional" })
      .eq("id", true)
      .select("id");
    if (opened.error || opened.data?.length !== 1) throw new Error("update failed");
  });
  aRest = await stage("start parent A's session", () => userSession(service, A.email));
  bRest = await stage("start parent B's session", () => userSession(service, B.email));
});

test.afterAll(async () => {
  test.setTimeout(360_000); // generous, and every step below is itself bounded
  const problems: string[] = [];
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch {
      problems.push(name); // a fixed label only: never the error text, which could hold a URL or a key
    }
  };
  const ids = [A.id, B.id].filter(Boolean);

  // 1. learn every upload id before its rows disappear
  await step("collect upload ids", async () => {
    if (!ids.length) return;
    const { data, error } = await service.from("video_uploads").select("id").in("owner_id", ids);
    if (error) throw new Error("read failed");
    for (const row of data ?? []) if (isUploadId(row.id)) tracked.add(row.id);
  });

  // 2. delete ONLY the exact tracked keys that appeared during the run; never touch anything else
  if (baseline) {
    await step("delete tracked objects", async () => {
      const plan = planCleanup({ tracked, before: baseline!.keys, after: await listAllKeys() });
      for (const key of plan.remove) {
        if (!isTrackedKey(key, tracked)) continue; // belt and braces: the plan can only contain tracked keys
        try {
          await withTimeout(real.remove(key), 30_000);
        } catch {
          problems.push("one object could not be deleted");
        }
      }
    });
    await step("verify the bucket", async () => {
      const left = planCleanup({ tracked, before: baseline!.keys, after: await listAllKeys() });
      if (left.remove.length) problems.push(`${left.remove.length} tracked object(s) remain`);
      if (left.unexpected) problems.push(`${left.unexpected} untracked new object(s) found and left untouched`);
    });
  } else if (ids.length) {
    problems.push("no bucket baseline, so no object was deleted"); // only a problem if something could have been created
  }

  // 3. database: rows of the two dummy users only (video_uploads follow their submissions), then the users, then the settings
  await step("delete submissions", async () => {
    if (ids.length) await service.from("submissions").delete().in("owner_id", ids);
  });
  for (const id of ids) await step("delete a dummy user", async () => void (await service.auth.admin.deleteUser(id)));
  if (baseline) {
    await step("restore settings", async () => void (await service.from("event_settings").update(baseline!.settings).eq("id", true)));
    await step("verify the database", async () => {
      const after = await service.from("event_settings").select(SETTINGS_COLUMNS).single();
      if (JSON.stringify(after.data) !== JSON.stringify(baseline!.settings)) problems.push("settings were not restored");
      if ((await submissionCount()) !== baseline!.submissions) problems.push("submission count differs from the baseline");
      if ((await uploadCount()) !== baseline!.uploads) problems.push("upload count differs from the baseline");
    });
  }
  if (problems.length) throw new Error(`cleanup incomplete: ${problems.join("; ")}`);
});

test("a real parent uploads one video through the app; it is verified, copied to videos/ and recorded; final submission stays disabled", async ({ page, context }) => {
  const consoleText: string[] = [];
  page.on("console", (m) => consoleText.push(m.text()));
  const puts: { url: string; status: number }[] = [];
  page.on("response", (r) => {
    const req = r.request();
    if (req.method() === "PUT" && new URL(req.url()).hostname.endsWith(".r2.cloudflarestorage.com")) puts.push({ url: req.url(), status: r.status() });
  });

  await signInThroughApp(page, context, service, A.email, EVENT);
  await expect(page).toHaveURL(new RegExp(`/events/${EVENT}/register$`), { timeout: 20_000 });
  await page.locator("#childName").fill(CHILD);
  await page.locator("#childAge").selectOption("9");
  await page.locator("#parentName").fill(PARENT);
  await page.locator("#mobile").fill(MOBILE);
  await page.locator("input[name=guardianConsent]").check();
  await page.getByRole("button", { name: /Save draft/ }).click();
  await expect(page).toHaveURL(/\?draft=[0-9a-f-]{36}&saved=1$/, { timeout: 20_000 });
  draftId = new URL(page.url()).searchParams.get("draft") ?? "";

  // the upload step is live only because THIS server was started with the switch on
  await expect(page.locator("#video-file")).toHaveCount(1);
  await page.locator("#video-file").setInputFiles({ name: "clip.webm", mimeType: "video/webm", buffer: MEDIA });
  // the app's own duration reader measured the same length the generator did (this is the browser-side check, not a server check)
  await expect(page.getByText(`${Math.round(FACTS.duration)} seconds`).first()).toBeVisible();
  await page.getByRole("button", { name: /Upload video/ }).first().click();
  await expect(page.getByText("Video uploaded").first()).toBeVisible({ timeout: 120_000 });

  // the browser PUT to the bucket succeeded (this proves CORS and the signed URL)
  expect(puts.length).toBe(1);
  expect(puts[0]!.status >= 200 && puts[0]!.status < 300).toBe(true);
  firstPutUrl = puts[0]!.url;
  firstId = idFromUrl(firstPutUrl);
  expect(isUploadId(firstId)).toBe(true);
  tracked.add(firstId);

  // Supabase (read with the parent's own session): the entry is uploaded and points at exactly that object id
  const rows = (await aRest.from("submissions").select("*")).data ?? [];
  expect(rows.length).toBe(1);
  expect(rows[0]!.id === draftId).toBe(true);
  expect(rows[0]!.status === "uploaded").toBe(true);
  expect(rows[0]!.video_key === firstId).toBe(true);
  expect(rows[0]!.finalized_at === null).toBe(true);

  // the bookkeeping row is verified (read with the secret key: provisioning-side check, not a permission assertion)
  const up = (await service.from("video_uploads").select("*").eq("id", firstId)).data?.[0];
  expect(up?.status === "verified").toBe(true);
  expect(Number(up?.verified_bytes) === MEDIA.length).toBe(true);
  expect(typeof up?.etag === "string" && up.etag.length > 0).toBe(true);

  // R2: the verified object is at videos/<id> with the right size and type, and pending/<id> was removed
  const [pendingKey, videoKey] = keysFor(firstId);
  const stored = await real.head(videoKey);
  expect(stored !== null && stored.bytes === MEDIA.length && stored.contentType === "video/webm").toBe(true);
  firstEtag = stored?.etag ?? "";
  expect(firstEtag.length > 0).toBe(true);
  // a single-part R2 ETag is the MD5 of what was stored: the stored bytes are the bytes that were sent (compared without downloading)
  const md5 = createHash("md5").update(MEDIA).digest("hex");
  test.info().annotations.push({ type: "finding", description: `stored object's ETag equals the MD5 of the uploaded file: ${firstEtag.replaceAll('"', "") === md5 ? "yes" : "NO"}` });
  expect((await real.head(pendingKey)) === null).toBe(true);

  // final submission stays disabled and nothing leaked into the page or the console
  await expect(page.getByRole("button", { name: /Submit entry/ })).toBeDisabled();
  expect(leaksSensitive(await page.content(), SECRETS)).toBe(false);
  expect(leaksSensitive(consoleText.join("\n"), SECRETS)).toBe(false);

  // the upload bookkeeping table is closed to parents' own sessions
  for (const client of [aRest, bRest]) {
    const res = await client.from("video_uploads").select("*");
    expect(res.error !== null || (res.data ?? []).length === 0).toBe(true);
    expect((res.data ?? []).length).toBe(0);
  }
});

test("another parent cannot use or probe the upload; reused and expired authorizations are refused; R2 is not contacted for any of them", async () => {
  const outcomes: unknown[] = [];

  // Parent B cannot start an upload for A's entry: nothing is signed
  let before = snapshot();
  const bStart = await startUpload(deps(), { ownerId: B.id, submissionId: draftId, meta: meta() });
  outcomes.push(bStart);
  expect(bStart).toEqual({ ok: false, code: "notFound" });
  expect(snapshot()).toEqual(before);

  // Parent B cannot finish A's real upload, and gets the same answer as for an id that does not exist; R2 is not asked
  before = snapshot();
  const bReal = await finishUpload(deps(), { ownerId: B.id, uploadId: firstId });
  const bFake = await finishUpload(deps(), { ownerId: B.id, uploadId: crypto.randomUUID() });
  outcomes.push(bReal, bFake);
  expect(bReal).toEqual({ ok: false, code: "notFound" });
  expect(bFake).toEqual(bReal);
  expect(snapshot()).toEqual(before);

  // A reusing the finished authorization is refused before R2
  before = snapshot();
  const reused = await finishUpload(deps(), { ownerId: A.id, uploadId: firstId });
  outcomes.push(reused);
  expect(reused).toEqual({ ok: false, code: "notCurrent" });
  expect(snapshot()).toEqual(before);

  // An authorization that has expired (backdated by the test) is refused before R2
  const second = await startUpload(deps(), { ownerId: A.id, submissionId: draftId, meta: meta() });
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  tracked.add(second.uploadId);
  await service.from("video_uploads").update({ expires_at: new Date(Date.now() - 11 * 60_000).toISOString() }).eq("id", second.uploadId);
  before = snapshot();
  const expired = await finishUpload(deps(), { ownerId: A.id, uploadId: second.uploadId });
  outcomes.push(expired);
  expect(expired).toEqual({ ok: false, code: "expired" });
  expect(snapshot()).toEqual(before);

  // Anything that is not an upload id never reaches the database or R2
  before = snapshot();
  for (const bad of ["pending/other", "../x", "", 5, null]) expect(await finishUpload(deps(), { ownerId: A.id, uploadId: bad })).toEqual({ ok: false, code: "invalid" });
  expect(snapshot()).toEqual(before);

  // None of the failure answers reveals a URL, a key, a bucket, an account or an address
  expect(leaksSensitive(JSON.stringify(outcomes), SECRETS)).toBe(false);
});

test("the verified video cannot be replaced through the old URL, and the signed content type is observed (recorded as a finding)", async () => {
  // 1. Re-using the first (already verified) upload URL before it expires only reaches pending/, never videos/
  const re = await fetch(firstPutUrl, { method: "PUT", headers: { "Content-Type": "video/webm" }, body: new Uint8Array(Buffer.concat([MEDIA, Buffer.from("tamper")])) });
  const [, videoKey] = keysFor(firstId);
  const after = await real.head(videoKey);
  expect(after !== null && after.etag === firstEtag && after.bytes === MEDIA.length).toBe(true); // the verified object is unchanged
  test.info().annotations.push({ type: "finding", description: `re-PUT to a used URL answered ${re.status >= 200 && re.status < 300 ? "success (lands in pending/ only, cleaned up)" : "a refusal"}; videos/ unchanged: yes` });

  // 2. A PUT whose Content-Type differs from the signed one: record whether the bucket refuses it
  const third = await startUpload(deps(), { ownerId: A.id, submissionId: draftId, meta: meta() });
  expect(third.ok).toBe(true);
  if (!third.ok) return;
  tracked.add(third.uploadId);
  const wrong = await fetch(third.url, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: new Uint8Array(MEDIA) });
  test.info().annotations.push({ type: "finding", description: `PUT with a different Content-Type was ${wrong.status >= 200 && wrong.status < 300 ? "ACCEPTED by the bucket (the server's HeadObject type check is then the protection)" : "refused by the bucket"}` });
  if (wrong.status >= 200 && wrong.status < 300) {
    // if the bucket accepted it, the server must still reject it at confirmation, and delete it
    const verdict = await finishUpload(deps(), { ownerId: A.id, uploadId: third.uploadId });
    expect(verdict.ok).toBe(false);
    expect((await real.head(keysFor(third.uploadId)[1])) === null).toBe(true);
  }
  expect((await aRest.from("submissions").select("video_key")).data?.[0]?.video_key === firstId).toBe(true); // the entry still points at the first video
});

test("when the administrator closes registration, no new upload is authorized and nothing is signed", async () => {
  await service.from("event_settings").update({ submissions_open_at: null, submissions_close_at: null, current_consent_version: null }).eq("id", true); // provisioning
  const before = snapshot();
  const res = await startUpload(deps(), { ownerId: A.id, submissionId: draftId, meta: meta() });
  expect(res).toEqual({ ok: false, code: "closed" });
  expect(snapshot()).toEqual(before);
});
