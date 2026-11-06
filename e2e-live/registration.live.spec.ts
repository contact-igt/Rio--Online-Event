// Live registration test through the real app and the real Supabase project (DEV only). NOT part of `npm run test:e2e`.
// Run ONLY this spec, after approval:  RIO_LIVE_CONFIRM=<dev ref> npm run test:e2e:live -- registration
//
// Who is allowed to do what:
//   * The secret key (the `service` client) provisions and cleans up fixtures only: it creates the dummy users, fetches
//     their one-time codes, sets the temporary registration window, takes the baseline, deletes what this run created and
//     restores the settings. It makes NO permission assertion.
//   * Every permission and persistence assertion uses a real signed-in session: the real browser (through the app) or a
//     Supabase client carrying the dummy parent's own JWT (`aRest`, `bRest`), so row level security decides what is
//     returned. Rows are read with the parent's own session, never with the secret key.
//
// What it does to the dev project (everything tagged with a unique run id, everything removed afterwards):
//   * creates 2 dummy auth users (<run>-a@example.test, <run>-b@example.test)
//   * TEMPORARILY OPENS REGISTRATION for 45 minutes: event_settings gets an open window and consent version
//     "v0-provisional"; the exact original values are restored afterwards (the dev database is closed today)
//   * registers a few dummy children through the real form; deletes those rows and users at the end
// It never touches the six events or any row it did not create, and compares the table counts and settings with a
// baseline at the end. Migration 20261105000400_media_consent.sql must already be applied to the dev project; if the
// column is missing the tests skip and say so (they do not apply it).
//
// Test 7 asserts that video upload is DISABLED. That holds only while RIO_UPLOADS_ENABLED is not exactly "yes" (the default,
// RIO_UPLOADS_ENABLED=no in .env.local); with uploads switched on this test is expected to fail by design.
//
// STATUS: first run authorized in M3B.2; see PROJECT_BRIEF.md section 15.

import { expect, test, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDummyUser, runId, serviceClient, signInThroughApp, userSession } from "./helpers";

const service = serviceClient(); // provisioning, baseline and cleanup ONLY
const run = runId("m3b");
const A = { id: "", email: `${run}-a@example.test` };
const B = { id: "", email: `${run}-b@example.test` };
const EVENT = "kutti-pesalar"; // ages 8-12, event id 4
const OTHER_EVENT = "tamil-kalaikoodam"; // ages 5-12, event id 5
const letters = (s: string) => s.replace(/[0-9]/g, "x");
const CHILD = letters(`Asha-${run}`);
const PARENT = letters(`Parent-${run}`);
const MOBILE = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const SETTINGS_COLUMNS = "submissions_open_at, submissions_close_at, current_consent_version, results_publish_at";
let baseline: { settings: Record<string, unknown>; submissions: number } | null = null;
let columnReady = true;
let draftId = "";
let aRest: SupabaseClient; // Dummy parent A's own session
let bRest: SupabaseClient; // Dummy parent B's own session

test.describe.configure({ mode: "serial" });

const count = async () => (await service.from("submissions").select("*", { count: "exact", head: true })).count ?? 0;
const ownRows = async (client: SupabaseClient) => (await client.from("submissions").select("*").order("created_at")).data ?? [];

async function fillAndSave(page: Page, over: { name?: string; age?: string; consent?: boolean; media?: boolean } = {}) {
  await page.locator("#childName").fill(over.name ?? CHILD);
  await page.locator("#childAge").selectOption(over.age ?? "9");
  await page.locator("#parentName").fill(PARENT);
  await page.locator("#mobile").fill(MOBILE);
  if (over.consent !== false) await page.locator("input[name=guardianConsent]").check();
  if (over.media) await page.locator("input[name=mediaConsent]").check();
  await page.getByRole("button", { name: /Save draft/ }).click();
}

test.beforeAll(async () => {
  // The server this suite talks to inherits this environment. With uploads switched on, test 7 ("upload stays disabled") would fail by design.
  if (process.env.RIO_UPLOADS_ENABLED === "yes") throw new Error("Refusing to run the registration suite while RIO_UPLOADS_ENABLED=yes.");
  const probe = await service.from("submissions").select("media_consent").limit(1);
  columnReady = !probe.error;
  const settings = await service.from("event_settings").select(SETTINGS_COLUMNS).single();
  if (settings.error) throw new Error(`cannot read settings: ${settings.error.message}`);
  baseline = { settings: settings.data as Record<string, unknown>, submissions: await count() };
  if (!columnReady) return;
  A.id = await createDummyUser(service, A.email);
  B.id = await createDummyUser(service, B.email);
  const opened = await service.from("event_settings").update({
    submissions_open_at: new Date(Date.now() - 60_000).toISOString(),
    submissions_close_at: new Date(Date.now() + 45 * 60_000).toISOString(),
    current_consent_version: "v0-provisional",
  }).eq("id", true).select("id");
  if (opened.error || opened.data?.length !== 1) throw new Error("could not open the temporary registration window");
  aRest = await userSession(service, A.email);
  bRest = await userSession(service, B.email);
});

test.afterAll(async () => {
  const ids = [A.id, B.id].filter(Boolean);
  if (ids.length) await service.from("submissions").delete().in("owner_id", ids);
  for (const id of ids) await service.auth.admin.deleteUser(id);
  if (baseline) {
    await service.from("event_settings").update(baseline.settings).eq("id", true);
    expect(await count()).toBe(baseline.submissions);
    const after = await service.from("event_settings").select(SETTINGS_COLUMNS).single();
    expect(after.data).toEqual(baseline.settings);
  }
});

test.beforeEach(() => test.skip(!columnReady, "migration 20261105000400_media_consent.sql is not applied to the dev project"));

test("a signed-in parent registers a child; the draft is saved with the right owner, email and consent", async ({ page, context }) => {
  await signInThroughApp(page, context, service, A.email, EVENT);
  await expect(page).toHaveURL(new RegExp(`/events/${EVENT}/register$`), { timeout: 20_000 });

  await fillAndSave(page, { consent: false });
  await expect(page.locator("p[role=alert]").first()).toContainText("Guardian consent is needed");
  expect(await ownRows(aRest)).toHaveLength(0); // nothing was saved without consent
  await expect(page.locator("#childAge")).toHaveValue("9"); // the age survives the error (M3B.2D); only consent is corrected below

  await page.locator("input[name=guardianConsent]").check();
  await page.locator("input[name=mediaConsent]").check();
  await page.getByRole("button", { name: /Save draft/ }).click();
  await expect(page).toHaveURL(/\?draft=[0-9a-f-]{36}&saved=1$/, { timeout: 20_000 });
  await expect(page.getByText("Draft saved").first()).toBeVisible();

  // read back with the parent's own session: owner and email come from the session, not from anything the browser sent
  const rows = await ownRows(aRest);
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  draftId = row.id;
  expect(row).toMatchObject({
    owner_id: A.id,
    parent_email: A.email.toLowerCase(),
    parent_name: PARENT,
    child_name: CHILD,
    parent_mobile: `+91${MOBILE}`,
    child_age: 9,
    event_id: 4,
    status: "draft",
    video_key: null,
    media_consent: true,
    consent_version: "v0-provisional",
  });
  expect(Date.now() - new Date(row.consent_at).getTime()).toBeLessThan(120_000);
});

test("the draft survives a refresh and can be resumed and edited", async ({ page, context }) => {
  await signInThroughApp(page, context, service, A.email, EVENT);
  await page.goto(`/events/${EVENT}/register?draft=${draftId}`);
  await expect(page.locator("#childName")).toHaveValue(CHILD);
  await page.reload();
  await expect(page.locator("#childName")).toHaveValue(CHILD);
  await expect(page.getByText("Draft saved")).toHaveCount(0); // only right after saving

  const before = (await ownRows(aRest))[0]!;
  await page.locator("#childName").fill(`${CHILD}b`);
  await page.getByRole("button", { name: /Save changes/ }).click();
  await expect(page).toHaveURL(/saved=1$/, { timeout: 20_000 });
  const after = (await ownRows(aRest))[0]!;
  expect(after.child_name).toBe(`${CHILD}b`);
  expect(after.consent_at).toBe(before.consent_at); // consent is not re-stamped by an edit
  expect(after.created_at).toBe(before.created_at);
  expect(after.parent_email).toBe(before.parent_email);
  expect(after.owner_id).toBe(A.id);
});

test("duplicates are caught, other children and other competitions are allowed", async ({ page, context }) => {
  await signInThroughApp(page, context, service, A.email, EVENT);
  await page.goto(`/events/${EVENT}/register`);
  await fillAndSave(page, { name: `${CHILD}b` });
  await expect(page.locator("p[role=alert]").first()).toContainText("already has a registration");
  expect(await ownRows(aRest)).toHaveLength(1);

  await fillAndSave(page, { name: `${CHILD}c` }); // a sibling
  await expect(page).toHaveURL(/saved=1$/, { timeout: 20_000 });
  expect(await ownRows(aRest)).toHaveLength(2);

  await page.goto(`/events/${OTHER_EVENT}/register`); // the same child, another competition
  await fillAndSave(page, { name: `${CHILD}b` });
  await expect(page).toHaveURL(/saved=1$/, { timeout: 20_000 });
  expect(await ownRows(aRest)).toHaveLength(3);
});

test("another parent cannot see or open the first parent's draft", async ({ page, context }) => {
  await signInThroughApp(page, context, service, B.email, EVENT);
  await page.goto(`/events/${EVENT}/register?draft=${draftId}`);
  await expect(page.getByText(CHILD)).toHaveCount(0);
  await expect(page.locator("#childName")).toHaveValue(""); // an empty new-child form, not A's draft
  await expect(page.getByText(/no registrations for this competition yet/)).toBeVisible();

  // and through the API with parent B's own session, row level security returns nothing of A's
  expect((await bRest.from("submissions").select("*").eq("id", draftId)).data).toEqual([]);
  expect(await ownRows(bRest)).toHaveLength(0);
  const aRows = await ownRows(aRest);
  expect(aRows.length).toBeGreaterThan(0);
  expect(aRows.every((r) => r.owner_id === A.id)).toBe(true);
  const attack = await bRest.from("submissions").update({ child_name: "Hacked" }).eq("id", draftId).select();
  expect(attack.data).toEqual([]);
  expect((await ownRows(aRest))[0]!.child_name).toBe(`${CHILD}b`); // unchanged
});

test("an expired session sends the parent back to sign-in with an explanation, and saves nothing", async ({ page, context }) => {
  await signInThroughApp(page, context, service, A.email, EVENT);
  await page.goto(`/events/${EVENT}/register`);
  await page.locator("#childName").fill(`${CHILD}z`);
  await context.clearCookies({ name: /^sb-/ }); // the browser's session is gone
  await page.locator("#childAge").selectOption("9");
  await page.locator("#parentName").fill(PARENT);
  await page.locator("#mobile").fill(MOBILE);
  await page.locator("input[name=guardianConsent]").check();
  await page.getByRole("button", { name: /Save draft/ }).click();
  await expect(page).toHaveURL(/\/signin\?event=kutti-pesalar&expired=1$/, { timeout: 20_000 });
  await expect(page.getByText(/Your session ended/)).toBeVisible();
  expect((await ownRows(aRest)).some((r) => r.child_name.endsWith("z"))).toBe(false);
});

test("when the administrator has not opened registration, the form is not shown and nothing can be saved", async ({ page, context }) => {
  await service.from("event_settings").update({ submissions_open_at: null, submissions_close_at: null, current_consent_version: null }).eq("id", true); // provisioning
  await signInThroughApp(page, context, service, A.email, EVENT);
  await page.goto(`/events/${EVENT}/register`);
  await expect(page.getByText("Registration has not opened yet")).toBeVisible();
  await expect(page.locator("#childName")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Upload video/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Submit entry/ })).toBeDisabled();

  // with the window closed, the database itself refuses a registration made with the parent's own session
  const refused = await aRest.from("submissions").insert({ event_id: 4, child_name: `${CHILD}q`, child_age: 9, parent_name: PARENT, parent_email: A.email.toLowerCase(), parent_mobile: `+91${MOBILE}`, consent_version: "v0-provisional" });
  expect(refused.error?.message).toContain("submissions_closed");
  expect((await ownRows(aRest)).some((r) => r.child_name.endsWith("q"))).toBe(false);
});

test("video upload and final submission stay disabled while registration is open", async ({ page, context }) => {
  await service.from("event_settings").update({
    submissions_open_at: new Date(Date.now() - 60_000).toISOString(),
    submissions_close_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    current_consent_version: "v0-provisional",
  }).eq("id", true); // provisioning: reopen the temporary window
  await signInThroughApp(page, context, service, A.email, EVENT);
  await page.goto(`/events/${EVENT}/register?draft=${draftId}`);
  await expect(page.getByRole("button", { name: /Upload video/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Submit entry/ })).toBeDisabled();
  await expect(page.locator("input[type=file]")).toHaveCount(0);
  const rows = await ownRows(aRest);
  expect(rows.every((r) => r.status === "draft" && r.video_key === null)).toBe(true);
});
