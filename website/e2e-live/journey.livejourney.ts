// LIVE end-to-end journey: parent -> upload -> final submission -> admin -> judge -> private playback -> scoring -> winner, through the
// REAL app in a REAL browser against the REAL dev Supabase project and the REAL dev R2 bucket. NOT part of any normal test run.
// NEVER run without a separate approval of this exact plan. Run only as
//
//   RIO_LIVE_CONFIRM=<dev ref> RIO_LIVE_JOURNEY_CONFIRM=<dev ref> RIO_LIVE_R2_CONFIRM=<dev bucket> npm run test:e2e:live:journey
//
// ONE test, ONE run, no retries. The uploads, final-submission and playback switches are turned on only for the web server this run
// starts (playwright.journey.config.ts), never in .env.local. See PROJECT_BRIEF.md section 31 for the plan, temporary writes and cleanup.
//
// Temporary writes (all tagged with a run id, all removed afterwards, audit rows excepted: the audit log is append-only evidence):
//   4 dummy auth users (parent, admin, judge1, judge2), 3 role rows and 2 judge profiles, ONE submission + ONE video_uploads row,
//   ONE judge assignment, ONE score, ONE winner, a temporary registration window (exact original settings restored),
//   R2: pending/<id> and videos/<id> of the single upload (exact keys only).
// Nothing here prints a URL, key, code, e-mail or id: assertions compare booleans, and the only output is fixed-label progress lines.
//
// Evidence limits: the video is a Chrome recording of an animated canvas (no person, voice or personal data), converted to an
// ordinary MP4. The link-expiry (5 minutes) and a phone-made MP4/MOV are NOT covered.

import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createR2Client, createR2Store, readR2Config } from "@/lib/storage/object-store";
import { inspectVideo } from "../lib/submit/inspect";
import { CLEANUP_ORDER, mp4Problems, playbackLinkProblems, preflightProblems, tamperedLinks, type Baseline } from "../scripts/live-journey";
import { authHealth, isTrackedKey, isUploadId, leaksSensitive, planCleanup, stage, withTimeout } from "../scripts/live-upload";
import { createDummyUser, runId, serviceClient, signInThroughApp, target, userSession } from "./helpers";
import { generateMp4, type Mp4Fixture } from "./media";

const cfg = readR2Config()!;
const r2 = createR2Client(cfg);
const real = createR2Store(cfg, r2);
const service = serviceClient(); // provisioning, evidence reads and cleanup ONLY
const anon = createClient(target.url, target.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
const run = runId("m4bj");
const ZERO = "00000000-0000-4000-8000-000000000000";
const EVENT = "kutti-pesalar";
const SECONDS = 33; // a margin over the 30 s minimum: the recorder can stop a moment early
const letters = (s: string) => s.replace(/[0-9]/g, "x");
const CHILD = letters(`Asha-${run}`);
const PARENT_NAME = letters(`Parent-${run}`);
const WINNER_NAME = letters(`Winner-${run}`);
const JUDGE1_NAME = `Judge One ${run}`;
const JUDGE2_NAME = `Judge Two ${run}`;
const MOBILE = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const SETTINGS_COLUMNS = "submissions_open_at, submissions_close_at, current_consent_version, results_publish_at";
const NOT_CALLABLE = ["42501", "PGRST202"]; // refused by permission, or invisible to the API: either way the caller cannot run it

type Who = "parent" | "admin" | "judge1" | "judge2";
const users: Record<Who, { id: string; email: string }> = {
  parent: { id: "", email: `${run}-parent@example.test` },
  admin: { id: "", email: `${run}-admin@example.test` },
  judge1: { id: "", email: `${run}-judge1@example.test` },
  judge2: { id: "", email: `${run}-judge2@example.test` },
};
const rest = {} as Record<Who, SupabaseClient>;
const NEEDLES = [CHILD, PARENT_NAME, MOBILE, users.parent.email, WINNER_NAME];
const SECRETS = [cfg.accountId, cfg.accessKeyId, cfg.secretAccessKey, cfg.bucket, ...Object.values(users).map((u) => u.email)];
const leaksPrivate = (value: unknown) => NEEDLES.some((n) => JSON.stringify(value ?? "").includes(n));
const note = (line: string) => console.log(`[journey] ${line}`); // fixed labels, booleans and counts only

let fixture: Mp4Fixture;
let baseline: { settings: Record<string, unknown>; counts: Record<string, number>; events: string; authUsers: number; keys: string[] } | null = null;
const tracked = new Set<string>(); // every upload id this run created
const created = { submissions: [] as string[] };
let submissionId = "";
let entryCode = "";

const count = async (table: string) => (await service.from(table).select("*", { count: "exact", head: true })).count ?? 0;
const COUNT_TABLES = ["submissions", "video_uploads", "judge_assignments", "scores", "winners", "judge_profiles", "user_roles", "audit_log"] as const;
const authUserCount = async () => {
  const res = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (res.error) throw new Error("list failed");
  return res.data.users.length;
};
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

/** A fresh browser context with a signed-in session for one of the dummy users, driven through the real sign-in screen. */
async function openAs(browser: Browser, who: Who, event: string | null): Promise<{ page: Page; context: BrowserContext; consoleText: string[] }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleText: string[] = [];
  page.on("console", (m) => consoleText.push(m.text()));
  await signInThroughApp(page, context, service, users[who].email, event);
  return { page, context, consoleText };
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(420_000);

  // 0. the video, BEFORE any hosted call: if it is not a genuine, playable MP4 with a true duration, nothing hosted is touched
  fixture = await stage("generate the test video", () => generateMp4(browser, SECONDS));
  const gate = mp4Problems(fixture.facts, fixture.header, SECONDS);
  if (gate.length > 0) throw new Error(`the generated test video is not acceptable: ${gate.join(", ")}`);
  const verdict = await inspectVideo("video/mp4", fixture.data.length, async (s, e) => new Uint8Array(fixture.data.subarray(s, e + 1)));
  if (!verdict.ok || verdict.durationSeconds === null) throw new Error("the real inspector does not accept the test video with a verified duration; nothing hosted was touched");
  note(`video fixture ok: mp4, ${Math.round(fixture.facts.duration)} s measured, inspector verified a duration, ${fixture.data.length} bytes`);

  // 1. fail fast, before any write
  const health = await authHealth(target.url, target.publishableKey);
  if (health !== "healthy") throw new Error(`Supabase Auth is not answering (${health}); nothing was written.`);

  // 2. read-only preflight: the migrations are there and DEV is in the expected empty state
  const probes = await stage("check the migrations", async () => {
    const play = await service.rpc("authorize_playback", { p_judge: ZERO, p_submission: ZERO });
    const check = await service.rpc("check_finalize", { p_owner: ZERO, p_submission: ZERO });
    const old = await service.rpc("finalize_submission", { p_id: ZERO });
    return { play: play.error?.message ?? "", check: check.error?.message ?? "", old: old.error?.code ?? "" };
  });
  if (probes.play !== "not_found" || probes.check !== "not_found" || !["PGRST202", "42883"].includes(probes.old)) throw new Error("migrations 00600 and 00700 are not in the expected state; nothing was written");

  const settings = await stage("read the settings baseline", async () => {
    const res = await service.from("event_settings").select(SETTINGS_COLUMNS).single();
    if (res.error) throw new Error("read failed");
    return res.data as Record<string, unknown>;
  });
  const counts: Record<string, number> = {};
  for (const t of COUNT_TABLES) counts[t] = await stage(`count ${t}`, () => count(t));
  const events = await stage("read the events", async () => {
    const res = await service.from("events").select("*").order("id");
    if (res.error) throw new Error("read failed");
    return JSON.stringify(res.data);
  });
  const keys = await stage("list the bucket baseline", () => listAllKeys());
  const authUsers = await stage("count auth users", authUserCount);
  baseline = { settings, counts, events, authUsers, keys };
  const shape: Baseline = {
    counts: { submissions: counts.submissions!, video_uploads: counts.video_uploads!, judge_assignments: counts.judge_assignments!, scores: counts.scores!, winners: counts.winners!, judge_profiles: counts.judge_profiles! },
    settings: settings as Baseline["settings"],
    bucketKeys: keys.length,
    events: (JSON.parse(events) as unknown[]).length,
  };
  const problems = preflightProblems(shape);
  if (problems.length) throw new Error(`preflight refused, nothing was written: ${problems.join("; ")}`);
  note("preflight ok: migrations present, dev empty, registration closed, bucket empty");

  // 3. writes, each stage named (the cleanup in afterAll knows about whatever was created so far)
  for (const who of ["parent", "admin", "judge1", "judge2"] as const) users[who].id = await stage(`create ${who}`, () => createDummyUser(service, users[who].email));
  await stage("grant the staff roles", async () => {
    const roles = await service.from("user_roles").insert([
      { user_id: users.admin.id, role: "admin" },
      { user_id: users.judge1.id, role: "judge" },
      { user_id: users.judge2.id, role: "judge" },
    ]);
    if (roles.error) throw new Error("insert failed");
    const profiles = await service.from("judge_profiles").insert([
      { user_id: users.judge1.id, display_name: JUDGE1_NAME },
      { user_id: users.judge2.id, display_name: JUDGE2_NAME },
    ]);
    if (profiles.error) throw new Error("insert failed");
  });
  await stage("open the temporary registration window", async () => {
    const opened = await service
      .from("event_settings")
      .update({ submissions_open_at: new Date(Date.now() - 60_000).toISOString(), submissions_close_at: new Date(Date.now() + 45 * 60_000).toISOString(), current_consent_version: "v0-provisional" })
      .eq("id", true)
      .select("id");
    if (opened.error || opened.data?.length !== 1) throw new Error("update failed");
  });
  for (const who of ["parent", "admin", "judge1", "judge2"] as const) rest[who] = await stage(`start ${who}'s session`, () => userSession(service, users[who].email));
  note("provisioned: 4 dummy users, roles, temporary registration window");
});

test.afterAll(async () => {
  test.setTimeout(420_000);
  const problems: string[] = [];
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch {
      problems.push(name); // a fixed label only: never the error text, which could hold a URL or a key
    }
  };
  const ids = Object.values(users).map((u) => u.id).filter(Boolean);
  let subs: string[] = [];

  // 1. learn every id this run created, before its rows disappear
  await step("collect ids", async () => {
    if (!ids.length) return;
    const s = await service.from("submissions").select("id").in("owner_id", ids);
    if (s.error) throw new Error("read failed");
    subs = [...new Set([...created.submissions, ...(s.data ?? []).map((r) => r.id as string)])];
    const up = await service.from("video_uploads").select("id").in("owner_id", ids);
    if (up.error) throw new Error("read failed");
    for (const row of up.data ?? []) if (isUploadId(row.id)) tracked.add(row.id);
  });

  // 2. R2: ONLY the exact keys of ids this run created
  if (baseline) {
    await step("delete tracked objects", async () => {
      const plan = planCleanup({ tracked, before: baseline!.keys, after: await listAllKeys() });
      for (const key of plan.remove) {
        if (!isTrackedKey(key, tracked)) continue;
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
    problems.push("no bucket baseline, so no object was deleted");
  }

  // 3. database, in CLEANUP_ORDER (children first); rows of this run's ids only; the audit log is never touched
  for (const table of CLEANUP_ORDER) {
    await step(`delete ${table}`, async () => {
      if (!ids.length && table !== "event_settings") return;
      switch (table) {
        case "winners":
          if (subs.length) await service.from("winners").delete().in("submission_id", subs);
          break;
        case "scores":
          if (subs.length) await service.from("scores").delete().in("submission_id", subs);
          await service.from("scores").delete().in("judge_id", ids);
          break;
        case "judge_assignments":
          if (subs.length) await service.from("judge_assignments").delete().in("submission_id", subs);
          break;
        case "submissions":
          if (subs.length) await service.from("submissions").delete().in("id", subs); // video_uploads follow their submissions
          break;
        case "judge_profiles":
          await service.from("judge_profiles").delete().in("user_id", [users.judge1.id, users.judge2.id].filter(Boolean));
          break;
        case "user_roles": {
          await service.from("user_roles").delete().in("user_id", [users.judge1.id, users.judge2.id].filter(Boolean));
          if (users.admin.id) {
            const del = await service.from("user_roles").delete().eq("user_id", users.admin.id);
            if (del.error) {
              // the database refuses to remove the last administrator: disable the account instead and say so
              await service.auth.admin.updateUserById(users.admin.id, { ban_duration: "876000h" });
              problems.push("the dummy administrator could not be removed (left banned)");
            }
          }
          break;
        }
        case "auth_users":
          for (const id of ids) {
            if (id === users.admin.id && problems.includes("the dummy administrator could not be removed (left banned)")) continue;
            await service.auth.admin.deleteUser(id);
          }
          break;
        case "event_settings":
          if (baseline) await service.from("event_settings").update(baseline.settings).eq("id", true);
          break;
      }
    });
  }

  // 4. verify against the baseline
  if (baseline) {
    await step("verify the database", async () => {
      const after = await service.from("event_settings").select(SETTINGS_COLUMNS).single();
      if (JSON.stringify(after.data) !== JSON.stringify(baseline!.settings)) problems.push("settings were not restored");
      for (const t of COUNT_TABLES) {
        const n = await count(t);
        if (t === "audit_log" ? n < baseline!.counts[t]! : n !== baseline!.counts[t]) problems.push(`${t} count differs from the baseline`);
      }
      const ev = await service.from("events").select("*").order("id");
      if (JSON.stringify(ev.data) !== baseline!.events) problems.push("the six events changed");
      if ((await authUserCount()) !== baseline!.authUsers) problems.push("auth user count differs from the baseline");
    });
  }
  note(problems.length ? "cleanup finished WITH PROBLEMS" : "cleanup verified: counts, settings, events, users and bucket equal the baseline (audit log only grew)");
  if (problems.length) throw new Error(`cleanup incomplete: ${problems.join("; ")}`);
});

test("parent -> upload -> final submission -> admin -> judge -> private playback -> scoring -> winner; results stay unpublished", async ({ browser }) => {
  test.setTimeout(900_000);
  const contexts: BrowserContext[] = [];
  const consoles: string[][] = [];
  const open = async (who: Who, event: string | null) => {
    const s = await openAs(browser, who, event);
    contexts.push(s.context);
    consoles.push(s.consoleText);
    return s;
  };
  try {
    // ---------------------------------------------------------------------------------------------------------- 1-3 parent
    const parent = await open("parent", EVENT);
    await test.step("1. the parent signs in with a real one-time code", async () => {
      await expect(parent.page).toHaveURL(new RegExp(`/events/${EVENT}/register$`), { timeout: 20_000 });
    });

    await test.step("2. the parent registers one dummy child", async () => {
      const page = parent.page;
      await page.locator("#childName").fill(CHILD);
      await page.locator("#childAge").selectOption("9");
      await page.locator("#parentName").fill(PARENT_NAME);
      await page.locator("#mobile").fill(MOBILE);
      await page.locator("input[name=guardianConsent]").check();
      await page.getByRole("button", { name: /Save draft/ }).click();
      await expect(page).toHaveURL(/\?draft=[0-9a-f-]{36}&saved=1$/, { timeout: 20_000 });
      submissionId = new URL(page.url()).searchParams.get("draft") ?? "";
      expect(isUploadId(submissionId)).toBe(true); // same UUID shape
      created.submissions.push(submissionId);
      const mine = (await rest.parent.from("submissions").select("id, status")).data ?? [];
      expect(mine.length === 1 && mine[0]!.status === "draft").toBe(true);
      entryCode = ((await service.from("submissions").select("entry_code").eq("id", submissionId).single()).data?.entry_code as string) ?? "";
      expect(entryCode.startsWith("RIO-")).toBe(true);
      note("2 ok: draft registered");
    });

    await test.step("3. the parent uploads a genuine playable MP4; the server verifies it", async () => {
      const page = parent.page;
      const puts: { url: string; status: number }[] = [];
      page.on("response", (r) => {
        const req = r.request();
        if (req.method() === "PUT" && new URL(req.url()).hostname.endsWith(".r2.cloudflarestorage.com")) puts.push({ url: req.url(), status: r.status() });
      });
      await page.locator("#video-file").setInputFiles({ name: "clip.mp4", mimeType: "video/mp4", buffer: fixture.data });
      await expect(page.getByText(`${Math.round(fixture.facts.duration)} seconds`).first()).toBeVisible();
      await page.getByRole("button", { name: /Upload video/ }).first().click();
      await expect(page.getByText("Video uploaded").first()).toBeVisible({ timeout: 120_000 });
      expect(puts.length === 1 && puts[0]!.status >= 200 && puts[0]!.status < 300).toBe(true);
      const uploadId = puts[0]!.url.match(/\/pending\/([0-9a-f-]{36})(?:\?|$)/)?.[1] ?? "";
      expect(isUploadId(uploadId)).toBe(true);
      tracked.add(uploadId);

      const row = (await service.from("video_uploads").select("*").eq("id", uploadId)).data?.[0];
      expect(row?.status === "verified" && Number(row?.verified_bytes) === fixture.data.length && row?.content_type === "video/mp4").toBe(true);
      const stored = await real.head(`videos/${uploadId}`);
      expect(stored !== null && stored.bytes === fixture.data.length && stored.contentType === "video/mp4").toBe(true);
      expect((await real.head(`pending/${uploadId}`)) === null).toBe(true);
      // what the server will inspect: the stored object, through the real store, with the REAL inspector
      const seen = await inspectVideo("video/mp4", stored!.bytes, (s, e) => real.readRange(`videos/${uploadId}`, s, e));
      expect(seen.ok && seen.container === "mp4" && seen.durationSeconds !== null && seen.durationSeconds >= 30 && seen.durationSeconds <= 90).toBe(true);
      note(`3 ok: uploaded, verified, stored as video/mp4; inspector verified a duration (~${Math.round(seen.ok ? (seen.durationSeconds ?? 0) : 0)} s) from the stored object`);
    });

    await test.step("4. a parent cannot finalize by calling the database directly", async () => {
      const args = { p_owner: users.parent.id, p_submission: submissionId, p_upload: ZERO, p_bytes: fixture.data.length, p_content_type: "video/mp4", p_etag: "x" };
      expect(NOT_CALLABLE).toContain((await rest.parent.rpc("finalize_verified_submission", args)).error?.code);
      expect(NOT_CALLABLE).toContain((await rest.parent.rpc("check_finalize", { p_owner: users.parent.id, p_submission: submissionId })).error?.code);
      expect((await rest.parent.from("submissions").update({ status: "finalized" }).eq("id", submissionId)).error?.code).toBe("42501");
      expect((await rest.parent.from("submissions").select("status").eq("id", submissionId).single()).data?.status).toBe("uploaded");
    });

    await test.step("5. the parent finalizes through the app; the database confirms it; it is locked", async () => {
      const page = parent.page;
      await page.getByRole("button", { name: /Submit entry$/ }).click();
      await expect(page.getByRole("heading", { name: /Check before you submit/ })).toBeFocused();
      await page.getByRole("button", { name: /Yes, submit my final entry/ }).click();
      await expect(page.getByRole("status").filter({ hasText: "Entry submitted" })).toBeVisible({ timeout: 60_000 });
      await expect.poll(async () => (await rest.parent.from("submissions").select("status, finalized_at").eq("id", submissionId).single()).data?.status, { timeout: 30_000 }).toBe("finalized");
      const row = (await rest.parent.from("submissions").select("status, finalized_at").eq("id", submissionId).single()).data;
      expect(row?.finalized_at !== null).toBe(true);
      const again = await service.rpc("check_finalize", { p_owner: users.parent.id, p_submission: submissionId });
      expect((again.data as { already: boolean }[])?.[0]?.already).toBe(true);
      expect((await rest.parent.from("submissions").update({ child_name: "Late" }).eq("id", submissionId).select()).data).toEqual([]);
      expect((await rest.parent.rpc("withdraw_submission", { p_id: submissionId })).error?.message).toBe("not_found");
      note("5 ok: finalized through the app and confirmed by the database; edit and withdraw refused");
    });

    // ---------------------------------------------------------------------------------------------------------- 6-7 admin
    const admin = await open("admin", null);
    await test.step("6. the administrator signs in and assigns Judge 1 to the competition", async () => {
      const page = admin.page;
      await page.goto(`/admin/events/${EVENT}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByText("Scoring incomplete").or(page.getByText("No judge assigned"))).toBeVisible();
      await page.locator("#judge").selectOption({ label: JUDGE1_NAME });
      await page.getByRole("button", { name: /Assign a judge/ }).click();
      await expect(page.getByText("1 entries added.")).toBeVisible({ timeout: 30_000 });
      const mine = (await service.from("judge_assignments").select("judge_id, submission_id")).data ?? [];
      expect(mine.length === 1 && mine[0]!.judge_id === users.judge1.id && mine[0]!.submission_id === submissionId).toBe(true);
      // a non-admin cannot assign: the database says so
      expect((await rest.judge1.rpc("assign_judge_to_event", { p_judge: users.judge2.id, p_event: 4 })).error?.message).toContain("forbidden");
      expect((await rest.parent.rpc("assign_judge_to_event", { p_judge: users.judge2.id, p_event: 4 })).error?.message).toContain("forbidden");
      expect(((await service.from("judge_assignments").select("judge_id")).data ?? []).length).toBe(1);
      note("6 ok: assigned Judge 1 only; non-admins refused");
    });

    // ---------------------------------------------------------------------------------------------------------- 8-10 judge 1
    const j1 = await open("judge1", null);
    let link = "";
    await test.step("7. Judge 1 sees only the assigned entry, with no child or parent details", async () => {
      const page = j1.page;
      await page.goto("/judge");
      await expect(page.getByRole("link", { name: new RegExp(entryCode) })).toBeVisible();
      expect(await page.getByRole("link", { name: /RIO-/ }).count()).toBe(1);
      expect(leaksPrivate(await page.content())).toBe(false);
      const view = (await rest.judge1.from("judge_entries").select("*")).data ?? [];
      expect(view.length === 1 && view[0]!.entry_id === submissionId).toBe(true);
      expect(leaksPrivate(view)).toBe(false);
      expect(((await rest.judge1.from("submissions").select("id")).data ?? []).length).toBe(0);
      await page.getByRole("link", { name: new RegExp(entryCode) }).click();
      await expect(page.getByRole("heading", { level: 1 })).toContainText(entryCode);
      expect(leaksPrivate(await page.content())).toBe(false);
      note("7 ok: Judge 1 sees one anonymous entry and nothing else");
    });

    await test.step("8. Judge 1 plays the private video through a short-lived link", async () => {
      const page = j1.page;
      // before pressing the button the page holds no video address at all
      expect(await page.locator("video").count()).toBe(0);
      expect(/r2\.cloudflarestorage|X-Amz-/i.test(await page.content())).toBe(false);
      await page.getByRole("button", { name: /Load video/ }).click();
      await expect(page.locator("video[src]")).toHaveCount(1, { timeout: 30_000 });
      link = (await page.locator("video").getAttribute("src")) ?? "";
      const uploadId = [...tracked][0]!;
      const bad = playbackLinkProblems(link, { host: `${cfg.accountId}.r2.cloudflarestorage.com`, videoKey: `videos/${uploadId}`, maxSeconds: 300 });
      expect(bad).toEqual([]); // fixed labels only, never the link
      // the browser really plays it
      const played = await page.locator("video").evaluate(async (v: HTMLVideoElement) => {
        v.muted = true;
        await new Promise<void>((resolve, reject) => {
          if (v.readyState >= 1) return resolve();
          v.onloadedmetadata = () => resolve();
          v.onerror = () => reject(new Error("cannot load"));
        });
        await v.play();
        await new Promise((r) => setTimeout(r, 2000));
        const ok = v.currentTime > 0.8 && v.videoWidth > 0 && Number.isFinite(v.duration) && v.duration > 29;
        v.pause();
        return ok;
      });
      expect(played).toBe(true);
      // the link serves exactly the uploaded bytes; a tampered or unsigned request is refused
      const ranged = await fetch(link, { headers: { Range: "bytes=0-1023" } });
      const body = Buffer.from(await ranged.arrayBuffer());
      expect([200, 206].includes(ranged.status) && body.subarray(0, 1024).equals(fixture.data.subarray(0, 1024))).toBe(true);
      const t = tamperedLinks(link);
      const refusedBad = (await fetch(t.badSignature)).status;
      const refusedUnsigned = (await fetch(t.unsigned)).status;
      expect(refusedBad >= 400 && refusedBad < 500).toBe(true);
      expect(refusedUnsigned >= 400 && refusedUnsigned < 500).toBe(true);
      // the issuance is in the audit log, with no personal data
      const audit = (await service.from("audit_log").select("actor, row_id, details").eq("action", "PLAYBACK_URL")).data ?? [];
      expect(audit.length >= 1 && audit.every((a) => a.actor === users.judge1.id && a.row_id === submissionId)).toBe(true);
      expect(leaksPrivate(audit)).toBe(false);
      note("8 ok: link <= 300 s for the bucket host and this object, plays in Chrome, serves the uploaded bytes, tampered and unsigned refused, audited");
    });

    // ---------------------------------------------------------------------------------------------------------- 11 judge 2
    const j2 = await open("judge2", null);
    await test.step("9. Judge 2 cannot reach that entry in any way", async () => {
      const page = j2.page;
      await page.goto("/judge");
      await expect(page.getByText("No entries are assigned to you yet")).toBeVisible();
      expect(await page.getByRole("link", { name: /RIO-/ }).count()).toBe(0);
      const res = await page.goto(`/judge/entries/${submissionId}`);
      expect(res?.status()).toBe(404);
      expect(((await rest.judge2.from("judge_entries").select("*")).data ?? []).length).toBe(0);
      expect(((await rest.judge2.from("submissions").select("id")).data ?? []).length).toBe(0);
      expect(((await rest.judge2.from("scores").select("id")).data ?? []).length).toBe(0);
      expect((await rest.judge2.from("scores").insert({ submission_id: submissionId, marks: 50 })).error?.code).toBe("42501");
      expect(NOT_CALLABLE).toContain((await rest.judge2.rpc("authorize_playback", { p_judge: users.judge2.id, p_submission: submissionId })).error?.code);
      note("9 ok: Judge 2 sees nothing, gets a 404, cannot score or authorize playback");
    });

    // ---------------------------------------------------------------------------------------------------------- 12-13 scoring
    await test.step("10. Judge 1 saves a draft score and then finalizes it", async () => {
      const page = j1.page;
      await page.goto(`/judge/entries/${submissionId}`);
      await page.getByLabel(/Marks/).fill("70");
      await page.getByLabel(/Comments/).fill("Clear voice");
      await page.getByRole("button", { name: /Save draft/ }).click();
      await expect.poll(async () => (await rest.judge1.from("scores").select("marks, status")).data?.[0]?.status, { timeout: 30_000 }).toBe("draft");
      const draft = (await rest.judge1.from("scores").select("marks, status")).data ?? [];
      expect(draft.length === 1 && Number(draft[0]!.marks) === 70).toBe(true);
      await page.reload();
      await expect(page.getByLabel(/Marks/)).toHaveValue("70");

      await page.getByLabel(/Marks/).fill("88.5");
      await page.getByRole("button", { name: /Submit final score/ }).click();
      await page.getByRole("button", { name: /Yes, submit my final score/ }).click();
      await expect.poll(async () => (await rest.judge1.from("scores").select("status")).data?.[0]?.status, { timeout: 30_000 }).toBe("final");
      await page.reload();
      await expect(page.getByText(/This score is final/)).toBeVisible();
      const fin = (await rest.judge1.from("scores").select("marks, status, finalized_at")).data ?? [];
      expect(fin.length === 1 && Number(fin[0]!.marks) === 88.5 && fin[0]!.finalized_at !== null).toBe(true);
      // one score per judge and entry; final is locked
      expect((await rest.judge1.from("scores").insert({ submission_id: submissionId, marks: 10 })).error?.code).toBe("23505");
      expect((await rest.judge1.from("scores").update({ marks: 10 }).eq("id", (await rest.judge1.from("scores").select("id")).data![0]!.id as string).select()).data).toEqual([]);
      // nobody else can read it
      for (const who of ["parent", "judge2"] as const) expect(((await rest[who].from("scores").select("*")).data ?? []).length, who).toBe(0);
      note("10 ok: draft saved, final saved and locked, duplicate refused, scores invisible to others");
    });

    // ---------------------------------------------------------------------------------------------------------- 14-15 winner
    await test.step("11. the administrator sees the ranking and confirms the winner", async () => {
      const page = admin.page;
      await page.goto(`/admin/events/${EVENT}`);
      const row = page.locator("tbody tr").filter({ hasText: entryCode });
      await expect(row).toContainText("88.5");
      await expect(row).toContainText("1 / 1");
      await expect(row).toContainText("Ready");
      await row.locator("summary").click();
      await row.getByLabel(/Display name/).fill(WINNER_NAME);
      await row.locator("form button[type=submit]").click();
      await expect(page.getByText("Winner, rank 1")).toBeVisible({ timeout: 30_000 });
      const winners = (await rest.admin.from("winners").select("rank, submission_id, display_name")).data ?? [];
      expect(winners.length === 1 && winners[0]!.rank === 1 && winners[0]!.submission_id === submissionId && winners[0]!.display_name === WINNER_NAME).toBe(true);
      note("11 ok: ranking shown (rank 1, average 88.5, complete) and the winner confirmed");
    });

    // ---------------------------------------------------------------------------------------------------------- 16-17 privacy
    await test.step("12. results stay unpublished and no unauthorized user can read entries, scores or winners", async () => {
      const settings = (await service.from("event_settings").select("results_publish_at").single()).data;
      expect(settings?.results_publish_at).toBeNull();
      for (const [name, client] of [["anon", anon], ["parent", rest.parent], ["judge1", rest.judge1], ["judge2", rest.judge2], ["admin", rest.admin]] as const) {
        const published = await client.from("published_winners").select("*");
        expect(published.error === null && (published.data ?? []).length === 0, `${name} published_winners`).toBe(true);
      }
      for (const [name, client] of [["anon", anon], ["judge1", rest.judge1], ["judge2", rest.judge2]] as const) {
        for (const table of ["submissions", "winners", "scores", "judge_assignments", "video_uploads", "audit_log"] as const) {
          const res = await client.from(table).select("*");
          expect(!leaksPrivate(res) && (res.error !== null || (res.data ?? []).length <= (table === "scores" || table === "judge_assignments" ? 1 : 0)), `${name} ${table}`).toBe(true);
        }
      }
      for (const table of ["winners", "audit_log", "video_uploads"] as const) {
        const res = await rest.parent.from(table).select("*");
        expect(res.error !== null || (res.data ?? []).length === 0, `parent ${table}`).toBe(true);
      }
      expect(leaksPrivate(await anon.from("judge_entries").select("*"))).toBe(false);
      note("12 ok: nothing published; anon, parent and judges read nothing private");
    });

    for (const text of consoles) {
      expect(leaksSensitive(text.join("\n"), SECRETS)).toBe(false);
    }
    note("all steps passed; every console was free of links, keys and addresses");
  } finally {
    for (const c of contexts) await c.close().catch(() => undefined);
  }
});
