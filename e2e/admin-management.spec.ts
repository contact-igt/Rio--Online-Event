import { expect, test, type Page } from "@playwright/test";
import { audit } from "./helpers/audit";
import { builtCss, openStaff, staffBundle, type OpenOptions } from "./helpers/staff-bundle";

// The REAL administrator screens added for management (sidebar, event settings, registrations, registration details, judges) in the installed
// Chrome with the built stylesheet, a fake database and fake server actions. Nothing is sent anywhere, no account exists, no e-mail is sent.
// Who is allowed to see what is proven against the real database rules in supabase/tests/admin-management.test.ts and by the static guards.

let bundle = "";
let css = "";
test.beforeAll(async () => {
  bundle = await staffBundle();
  css = builtCss();
});

const REG = (n: number) => `bbbbbbbb-bbbb-4bbb-8bbb-00000000000${n}`;
const VIDEO_KEY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const row = (n: number, o: Record<string, unknown>) => ({
  id: REG(n),
  entry_code: `RIO-TEST${n}-0000${n}`,
  event_id: 2,
  status: "draft",
  child_name: `Child ${n}`,
  child_age: 6,
  parent_name: `Parent ${n}`,
  parent_email: `parent${n}@example.test`,
  parent_mobile: `+91 98765 4321${n}`,
  consent_version: "v0-provisional",
  consent_at: "2026-11-07T04:00:00Z",
  media_consent: false,
  video_key: null,
  created_at: `2026-11-0${n}T04:00:00Z`,
  updated_at: `2026-11-0${n}T05:00:00Z`,
  finalized_at: null,
  withdrawn_at: null,
  ...o,
});
const submissions = [
  row(1, { status: "draft" }),
  row(2, { status: "uploaded", video_key: VIDEO_KEY, event_id: 3, child_age: 7, media_consent: true }),
  row(3, { status: "finalized", video_key: VIDEO_KEY, finalized_at: "2026-11-07T10:00:00Z", child_name: "Kavin Final", parent_name: "Kavitha Final" }),
  row(4, { status: "withdrawn", withdrawn_at: "2026-11-07T11:00:00Z" }),
];
const J = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-00000000010${n}`;
const judges = {
  judge_profiles: [
    { user_id: J(1), display_name: "Judge One", active: true },
    { user_id: J(2), display_name: "Judge Two", active: true },
    { user_id: J(3), display_name: "Judge Three", active: false },
  ],
  judge_assignments: [{ judge_id: J(2) }, { judge_id: J(2) }, { judge_id: J(2) }, { judge_id: J(2) }],
  scores: [{ judge_id: J(2), status: "final" }],
};
const authInfo = {
  [J(1)]: { email: "one@example.test", lastSignInAt: null },
  [J(2)]: { email: "two@example.test", lastSignInAt: "2026-11-06T10:00:00Z" },
  [J(3)]: { email: "three@example.test", lastSignInAt: "2026-11-01T10:00:00Z" },
};
const open = (page: Page, hash: string, o: OpenOptions = {}) => openStaff(page, bundle, css, hash, o);
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __adminCalls?: unknown[] }).__adminCalls ?? []);

test.describe("sidebar", () => {
  test("lists the seven entries in order, marks the current one, and links only inside the admin area", async ({ page }) => {
    await open(page, "nav", { path: "/admin/judges" });
    const items = page.getByRole("navigation", { name: "Administration" }).getByRole("link");
    await expect(items).toHaveText([/Dashboard/, /Registrations/, /Judges/, /Assign Judges/, /Scoring/, /Results/, /Event Settings/]);
    await expect(page.locator("a[aria-current=page]")).toHaveCount(1);
    await expect(page.locator("a[aria-current=page]")).toContainText("Judges");
    const hrefs = await items.evaluateAll((els) => els.map((e) => e.getAttribute("href")));
    expect(hrefs).toEqual(["/admin", "/admin/registrations", "/admin/judges", "/admin#competitions", "/admin#competitions", "/admin#competitions", "/admin#event-settings"]);
  });

  test("on a competition page, Assign Judges, Scoring and Results jump to that page's own sections", async ({ page }) => {
    await open(page, "nav", { path: "/admin/events/kutti-pesalar" });
    const hrefs = await page.getByRole("navigation", { name: "Administration" }).getByRole("link").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
    expect(hrefs.slice(3, 6)).toEqual(["/admin/events/kutti-pesalar#assign", "/admin/events/kutti-pesalar#ranking", "/admin/events/kutti-pesalar#winners"]);
  });
});

test.describe("layout with the sidebar", () => {
  test("on a wide screen the sidebar sits to the left of the page and does not overlap it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "layout", { path: "/admin" });
    const nav = (await page.getByRole("navigation", { name: "Administration" }).boundingBox())!;
    const content = (await page.locator("h1").first().boundingBox())!;
    expect(nav.x + nav.width).toBeLessThanOrEqual(content.x);
    expect(nav.width).toBeGreaterThan(200);
  });

  test("on a phone the sidebar is a wrapping row of buttons above the page, with no horizontal scroll", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await open(page, "layout", { path: "/admin" });
    const nav = (await page.getByRole("navigation", { name: "Administration" }).boundingBox())!;
    const content = (await page.locator("h1").first().boundingBox())!;
    expect(nav.y + nav.height).toBeLessThanOrEqual(content.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await ctx.close();
  });
});

test.describe("event settings (read-only)", () => {
  const settings = (o: Record<string, unknown>) => ({ event_settings: [{ submissions_open_at: null, submissions_close_at: null, current_consent_version: null, ...o }] });

  test("shows Closed with 'Not configured' when nothing is set, and the timezone", async ({ page }) => {
    await open(page, "admin", { data: settings({}) });
    const box = page.locator("#event-settings");
    await expect(box).toContainText("Closed");
    await expect(box).toContainText("Not configured");
    await expect(box).toContainText("Asia/Kolkata");
    await expect(box).toContainText("Read-only");
  });

  test("shows Open and the configured dates in IST when the window is current, and Closed before it opens", async ({ page }) => {
    await open(page, "admin", { data: settings({ submissions_open_at: "2020-01-01T00:00:00Z", submissions_close_at: "2099-01-01T00:00:00Z", current_consent_version: "v0-provisional" }) });
    const box = page.locator("#event-settings");
    await expect(box.locator("dd").first()).toHaveText("Open");
    await expect(box).toContainText("1 Jan 2020, 5:30 am"); // 00:00 UTC is 05:30 IST
    await expect(box).toContainText("1 Jan 2099");
    await open(page, "admin", { data: settings({ submissions_open_at: "2098-01-01T00:00:00Z", submissions_close_at: "2099-01-01T00:00:00Z", current_consent_version: "v0-provisional" }) });
    await expect(page.locator("#event-settings dd").first()).toHaveText("Closed");
  });

  test("offers no way to change anything: no form, input, select or button inside the section", async ({ page }) => {
    await open(page, "admin", { data: settings({ submissions_open_at: "2020-01-01T00:00:00Z", submissions_close_at: "2099-01-01T00:00:00Z", current_consent_version: "v0-provisional" }) });
    expect(await page.locator("#event-settings form, #event-settings input, #event-settings select, #event-settings button, #event-settings textarea").count()).toBe(0);
  });
});

test.describe("registrations", () => {
  test("summary numbers are counted from the rows; only Finalized is a completed submission", async ({ page }) => {
    await open(page, "registrations", { data: { submissions } });
    const tile = (label: string) => page.locator("ul[aria-label=Summary] li").filter({ hasText: label });
    await expect(tile("Total registrations")).toContainText("4");
    await expect(tile("Draft registrations")).toContainText("1");
    await expect(tile("Awaiting video / finalization")).toContainText("1");
    await expect(tile("Finalized entries")).toContainText("1");
    await expect(tile("Withdrawn entries")).toContainText("1");
    await expect(page.getByText(/A draft is not a submission/)).toBeVisible();
  });

  test("the table shows reference, child, competition, parent, status, video and submission time, and never a draft as submitted", async ({ page }) => {
    await open(page, "registrations", { data: { submissions } });
    const rows = page.locator("table tbody tr");
    await expect(rows).toHaveCount(4);
    const draft = rows.filter({ hasText: "RIO-TEST1-00001" });
    await expect(draft).toContainText("Child 1");
    await expect(draft).toContainText("Parent 1");
    await expect(draft).toContainText("Draft (not submitted)");
    await expect(draft).toContainText("No video yet");
    await expect(draft).toContainText("Not submitted");
    const done = rows.filter({ hasText: "RIO-TEST3-00003" });
    await expect(done).toContainText("Finalized");
    await expect(done).toContainText("Uploaded and verified");
    await expect(done).toContainText("7 Nov 2026, 3:30 pm"); // 10:00 UTC is 15:30 IST
    await expect(rows.filter({ hasText: "RIO-TEST2-00002" })).toContainText("Awaiting final submission");
    await expect(done.getByRole("link", { name: /Details for RIO-TEST3-00003/ })).toHaveAttribute("href", `/admin/registrations/${REG(3)}`);
  });

  test("search and filters narrow the list; no match explains itself; the form only reads (GET)", async ({ page }) => {
    await open(page, "registrations|q=kavitha", { data: { submissions } });
    await expect(page.locator("table tbody tr")).toHaveCount(1);
    await expect(page.getByRole("status")).toContainText("1 of 4 registrations");
    await open(page, "registrations|status=draft", { data: { submissions } });
    await expect(page.locator("table tbody tr")).toHaveCount(1);
    await open(page, "registrations|event=3", { data: { submissions } });
    await expect(page.locator("table tbody tr")).toHaveCount(1);
    await open(page, "registrations|q=zzzz", { data: { submissions } });
    await expect(page.getByText(/No registration matches/)).toBeVisible();
    await open(page, "registrations|status=hacked&event=99&page=-3", { data: { submissions } }); // unexpected input means no filter, never an error
    await expect(page.locator("table tbody tr")).toHaveCount(4);
    await expect(page.locator("form[role=search]")).toHaveAttribute("method", "get");
  });

  test("an empty system says so instead of inventing rows", async ({ page }) => {
    await open(page, "registrations", { data: { submissions: [] } });
    await expect(page.getByText("No registrations exist yet.")).toBeVisible();
    await expect(page.locator("ul[aria-label=Summary] li").first()).toContainText("0");
  });

  test("the private video reference never appears in the page", async ({ page }) => {
    await open(page, "registrations", { data: { submissions } });
    expect(await page.locator("#root").innerHTML()).not.toContain(VIDEO_KEY);
    await open(page, `registration:${REG(3)}`, { data: { submissions } });
    expect(await page.locator("#root").innerHTML()).not.toContain(VIDEO_KEY);
  });
});

test.describe("registration details", () => {
  test("a finalized entry shows every required field", async ({ page }) => {
    await open(page, `registration:${REG(3)}`, { data: { submissions } });
    const text = await page.locator("#root").innerText();
    for (const t of ["RIO-TEST3-00003", "Kavin Final", "6 years", "Kavitha Final", "parent3@example.test", "+91 98765 43213", "Little Storytellers", "Guardian consent (required)", "Recorded", "v0-provisional", "Media sharing (optional)", "Not agreed", "Saved draft", "Video verified", "Final submission", "Yes, submitted 7 Nov 2026, 3:30 pm"]) {
      expect(text, t).toContain(t);
    }
    await expect(page.getByText(/NOT a completed submission/)).toHaveCount(0);
    await expect(page.getByText("Personal data of a child and a parent. For administrators only.")).toBeVisible();
  });

  test("a draft is plainly NOT a completed submission", async ({ page }) => {
    await open(page, `registration:${REG(1)}`, { data: { submissions } });
    await expect(page.getByText(/This is NOT a completed submission/)).toBeVisible();
    await expect(page.getByText("No video has been uploaded", { exact: false })).toBeVisible();
    const submission = page.locator("dt", { hasText: "Final submission" }).locator("xpath=following-sibling::dd");
    await expect(submission).toHaveText("No");
    const verified = page.locator("dt", { hasText: "Video verified" }).locator("xpath=following-sibling::dd");
    await expect(verified).toContainText("No");
  });

  test("an awaiting entry says the video is verified but not submitted, and media consent shows Agreed", async ({ page }) => {
    await open(page, `registration:${REG(2)}`, { data: { submissions } });
    await expect(page.getByText(/video is uploaded and verified, but the parent has not submitted/)).toBeVisible();
    await expect(page.getByText("Agreed", { exact: true })).toBeVisible();
  });
});

test.describe("judges", () => {
  const ready = { enabled: true, secretKey: "ok" as const, ready: true };
  const PASSWORD = "Kd7m-Qp3x-Wn8c-Rt5v-Hj2f";
  const fill = async (page: Page, name = "New Judge", email = "new.judge@example.test", verified = true) => {
    await page.getByLabel(/Judge name/).fill(name);
    await page.getByLabel(/^Email/).fill(email);
    if (verified) await page.getByLabel(/I have confirmed that this e-mail/).check();
  };

  test("lists name, e-mail, status, assigned and progress; status is Not signed in yet, Active or Inactive in words", async ({ page }) => {
    await open(page, "judges", { data: judges, provisioning: ready, authInfo });
    const rows = page.locator("table tbody tr");
    await expect(rows).toHaveCount(3);
    const one = rows.filter({ hasText: "Judge One" });
    await expect(one).toContainText("one@example.test");
    await expect(one).toContainText("Not signed in yet");
    const two = rows.filter({ hasText: "Judge Two" });
    await expect(two).toContainText("Active");
    await expect(two).toContainText("25%");
    await expect(two).toContainText("1 final, 0 draft");
    await expect(two.locator("td").nth(2)).toContainText("4");
    await expect(rows.filter({ hasText: "Judge Three" })).toContainText("Inactive");
    await expect(rows.filter({ hasText: "Judge Three" }).getByRole("button", { name: /Activate Judge Three/ })).toBeVisible();
    await expect(rows.filter({ hasText: "Judge Two" }).getByRole("button", { name: /Deactivate Judge Two/ })).toBeVisible();
    await expect(rows.filter({ hasText: "Judge Two" }).getByRole("button", { name: /Reset password Judge Two/ })).toBeVisible();
  });

  test("a judge who still has the administrator's password is marked Password change pending", async ({ page }) => {
    await open(page, "judges", { data: judges, provisioning: ready, authInfo: { ...authInfo, [J(1)]: { ...authInfo[J(1)], mustChangePassword: true } } });
    await expect(page.locator("table tbody tr").filter({ hasText: "Judge One" })).toContainText("Password change pending");
    await expect(page.locator("table tbody tr").filter({ hasText: "Judge Two" })).not.toContainText("Password change pending");
  });

  test("while adding judges is switched off the form is disabled, says so, and nothing can be created", async ({ page }) => {
    await open(page, "judges", { data: judges });
    await expect(page.getByText(/Adding judges is switched off/)).toBeVisible();
    await expect(page.getByText(/RIO_STAFF_PROVISIONING_ENABLED/).first()).toBeVisible();
    await expect(page.getByLabel(/Judge name/)).toBeDisabled();
    await expect(page.getByLabel(/^Email/)).toBeDisabled();
    await expect(page.getByLabel(/I have confirmed that this e-mail/)).toBeDisabled();
    await expect(page.getByRole("button", { name: /Add judge/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Reset password Judge Two/ })).toBeDisabled();
    expect(await calls(page)).toEqual([]);
    await expect(page.getByText(/Judge added/)).toHaveCount(0);
  });

  test("switch on but the secret key missing: a clear configuration warning, still disabled", async ({ page }) => {
    await open(page, "judges", { data: judges, provisioning: { enabled: true, secretKey: "missing", ready: false } });
    await expect(page.getByText(/secret key is missing or malformed/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Add judge/ })).toBeDisabled();
  });

  test("without the lookup, judges are still listed from their profiles and the page says e-mail addresses are unavailable", async ({ page }) => {
    await open(page, "judges", { data: judges, provisioning: { enabled: true, secretKey: "missing", ready: false } });
    await expect(page.getByText(/Judge e-mail addresses and sign-in status are not shown/)).toBeVisible();
    await expect(page.locator("table tbody tr")).toHaveCount(3);
  });

  test("the form says nothing is e-mailed and the judge chooses their own password at first sign-in", async ({ page }) => {
    await open(page, "judges", { data: judges, provisioning: ready, authInfo });
    await expect(page.getByText(/Nothing is e-mailed/)).toBeVisible();
    await expect(page.getByText(/must choose their own password at first sign-in/)).toBeVisible();
  });

  test("the ownership box is forwarded exactly as ticked (the server enforces it) and an unconfirmed address is never shown as added", async ({ page }) => {
    await open(page, "judges", { data: judges, provisioning: ready, authInfo, adminScript: { provision: [{ ok: false, code: "emailNotConfirmed" }] } });
    await fill(page, "New Judge", "new.judge@example.test", false);
    await page.getByRole("button", { name: /Add judge/ }).click();
    expect(await calls(page)).toEqual([{ fn: "provision", input: { email: "new.judge@example.test", displayName: "New Judge", emailVerified: false } }]);
    await expect(page.getByRole("alert").filter({ hasText: /Tick the box to confirm/ })).toBeVisible();
    await expect(page.getByText(/Judge added/)).toHaveCount(0);
  });

  test("adds one judge, claims success only after the server accepts, then shows the password once with copy controls and no way to store it", async ({ page }) => {
    await open(page, "judges", {
      data: judges,
      provisioning: ready,
      authInfo,
      adminScript: { provision: ["hold", { ok: true, email: "new.judge@example.test", password: PASSWORD }] },
    });
    await fill(page);
    const add = page.getByRole("button", { name: /Add judge|Adding/ });
    await add.dblclick();
    await expect(add).toBeDisabled();
    expect(await calls(page)).toEqual([{ fn: "provision", input: { email: "new.judge@example.test", displayName: "New Judge", emailVerified: true } }]);
    await expect(page.getByText(PASSWORD)).toHaveCount(0); // nothing is claimed while the request is open
    await page.evaluate(() => (window as unknown as { __adminRelease: () => void }).__adminRelease());
    await expect(page.getByText(/Judge added: new.judge@example.test/)).toBeVisible();
    const panel = page.getByRole("group", { name: /Sign-in details/ });
    await expect(panel.getByText(PASSWORD)).toBeVisible();
    await expect(panel.getByText(/shown only once/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Copy password" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Copy sign-in details" })).toBeVisible();
    // the password is plain text, never in a form field (so a browser or password manager does not offer to save it), a URL or storage
    await expect(panel.locator("input")).toHaveCount(0);
    expect(page.url()).not.toContain(PASSWORD);
    // (browser storage is not available on this test page; the static guard in lib/staff/admin-boundary.test.ts forbids any use of it by these components)
    await expect(page.getByLabel(/^Email/)).toHaveValue(""); // the typed values are cleared
    expect((await calls(page)).length).toBe(1);
    await panel.getByRole("button", { name: /I have saved it/ }).click();
    await expect(page.getByText(PASSWORD)).toHaveCount(0);
    await expect(page.getByText(/The password is hidden/)).toBeVisible();
  });

  test("copying puts the password, or the whole sign-in details, on the clipboard and says so", async ({ page }) => {
    await open(page, "judges", { data: judges, provisioning: ready, authInfo, adminScript: { provision: [{ ok: true, email: "new.judge@example.test", password: PASSWORD }] } });
    await page.evaluate(() => {
      const w = window as unknown as { __copied: string[] };
      w.__copied = [];
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => void w.__copied.push(t) }, configurable: true });
    });
    await fill(page);
    await page.getByRole("button", { name: /Add judge/ }).click();
    const panel = page.getByRole("group", { name: /Sign-in details/ });
    await panel.getByRole("button", { name: "Copy password" }).click();
    await expect(panel.getByText("Copied.")).toBeVisible();
    await panel.getByRole("button", { name: "Copy sign-in details" }).click();
    const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
    expect(copied[0]).toBe(PASSWORD);
    expect(copied[1]).toContain("Email: new.judge@example.test");
    expect(copied[1]).toContain(`Password: ${PASSWORD}`);
    expect(copied[1]).toContain("/staff/login");
  });

  test("when copying is not allowed the screen says to copy by hand instead of pretending it worked", async ({ page }) => {
    await open(page, "judges", { data: judges, provisioning: ready, authInfo, adminScript: { provision: [{ ok: true, email: "new.judge@example.test", password: PASSWORD }] } });
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) }, configurable: true }));
    await fill(page);
    await page.getByRole("button", { name: /Add judge/ }).click();
    await page.getByRole("button", { name: "Copy password" }).click();
    await expect(page.getByText(/Could not copy automatically/)).toBeVisible();
    await expect(page.getByText("Copied.")).toHaveCount(0);
  });

  test("duplicate, partial, rolled-back, rate-limited and refused answers are shown plainly, never as success, and never show a password", async ({ page }) => {
    const cases: [string, RegExp][] = [
      ["duplicate", /already has an account/],
      ["partial", /could not be fully removed/],
      ["provisionFailed", /nothing is left behind/],
      ["createFailed", /Nothing was created/],
      ["tooMany", /Too many attempts/],
      ["notAllowed", /Only an administrator/],
      ["disabled", /switched off/],
      ["notConfigured", /not configured/],
    ];
    for (const [code, message] of cases) {
      await open(page, "judges", { data: judges, provisioning: ready, authInfo, adminScript: { provision: [{ ok: false, code }] } });
      await fill(page, "X", "x@example.test");
      await page.getByRole("button", { name: /Add judge/ }).click();
      await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
      await expect(page.getByText(/Judge added/)).toHaveCount(0);
      await expect(page.getByRole("group", { name: /Sign-in details/ })).toHaveCount(0);
    }
  });

  test("a network failure is shown as unavailable, not as success", async ({ page }) => {
    await open(page, "judges", { data: judges, provisioning: ready, authInfo, adminScript: { provision: ["throw"] } });
    await fill(page);
    await page.getByRole("button", { name: /Add judge/ }).click();
    await expect(page.getByRole("alert").filter({ hasText: /Not possible right now/ })).toBeVisible();
  });

  test("resetting a password asks first; Cancel sends nothing; confirming asks the server and shows the new password once", async ({ page }) => {
    await open(page, "judges", { data: judges, provisioning: ready, authInfo, adminScript: { reset: [{ ok: true, password: PASSWORD }] } });
    const row = page.locator("table tbody tr").filter({ hasText: "Judge Two" });
    await row.getByRole("button", { name: /Reset password Judge Two/ }).click();
    await expect(row.getByText(/current password stops working at once/)).toBeVisible();
    expect(await calls(page)).toEqual([]);
    await row.getByRole("button", { name: "Cancel" }).click();
    expect(await calls(page)).toEqual([]);
    await row.getByRole("button", { name: /Reset password Judge Two/ }).click();
    await row.getByRole("button", { name: /Yes, reset/ }).click();
    await expect.poll(async () => (await calls(page)).length).toBe(1);
    expect(await calls(page)).toEqual([{ fn: "reset", input: { judgeId: J(2) } }]);
    await expect(row.getByText(PASSWORD)).toBeVisible();
    await row.getByRole("button", { name: /I have saved it/ }).click();
    await expect(page.getByText(PASSWORD)).toHaveCount(0);
  });

  test("a failed reset says the old password still works and shows no password", async ({ page }) => {
    await open(page, "judges", { data: judges, provisioning: ready, authInfo, adminScript: { reset: [{ ok: false, code: "unavailable" }] } });
    const row = page.locator("table tbody tr").filter({ hasText: "Judge Two" });
    await row.getByRole("button", { name: /Reset password Judge Two/ }).click();
    await row.getByRole("button", { name: /Yes, reset/ }).click();
    await expect(row.getByRole("alert")).toContainText("The old password still works");
    await expect(row.getByRole("group", { name: /Sign-in details/ })).toHaveCount(0);
  });

  test("deactivating needs an explicit confirmation; Cancel sends nothing; confirming sends confirmed:true", async ({ page }) => {
    await open(page, "judges", { data: judges, provisioning: ready, authInfo });
    await page.getByRole("button", { name: /Deactivate Judge Two/ }).click();
    await expect(page.getByText(/immediately lose access to every entry and video/)).toBeVisible();
    expect(await calls(page)).toEqual([]);
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(await calls(page)).toEqual([]);
    await page.getByRole("button", { name: /Deactivate Judge Two/ }).click();
    await page.getByRole("button", { name: /Yes, deactivate/ }).click();
    await expect.poll(async () => (await calls(page)).length).toBe(1);
    expect(await calls(page)).toEqual([{ fn: "active", input: { judgeId: J(2), active: false, confirmed: true } }]);
  });

  test("activating needs no confirmation and sends active:true", async ({ page }) => {
    await open(page, "judges", { data: judges, provisioning: ready, authInfo });
    await page.getByRole("button", { name: /Activate Judge Three/ }).click();
    await expect.poll(async () => (await calls(page)).length).toBe(1);
    expect(await calls(page)).toEqual([{ fn: "active", input: { judgeId: J(3), active: true } }]);
  });

  test("a refusal from the server is shown next to the judge", async ({ page }) => {
    await open(page, "judges", { data: judges, provisioning: ready, authInfo, adminScript: { active: [{ ok: false, code: "notAllowed" }] } });
    await page.getByRole("button", { name: /Activate Judge Three/ }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Only an administrator can do this." })).toBeVisible();
  });

  test("an empty list says how judges arrive", async ({ page }) => {
    await open(page, "judges", { data: { judge_profiles: [], judge_assignments: [], scores: [] }, provisioning: ready });
    await expect(page.getByText(/No judges exist yet/)).toBeVisible();
  });
});

for (const vp of [
  { n: "360", w: 360, h: 780 },
  { n: "390", w: 390, h: 844 },
  { n: "768", w: 768, h: 1024 },
  { n: "1440", w: 1440, h: 900 },
] as const) {
  test.describe(`at ${vp.n}px`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h }, hasTouch: vp.w < 1024, isMobile: vp.w < 768 });
    const screens: [string, string, OpenOptions][] = [
      ["registrations", "registrations", { data: { submissions } }],
      ["registration details", `registration:${REG(3)}`, { data: { submissions } }],
      ["judges", "judges", { data: judges, provisioning: { enabled: true, secretKey: "ok", ready: true }, authInfo }],
      ["judges (adding off)", "judges", { data: judges }],
      ["dashboard with event settings", "admin", { data: { event_settings: [{ submissions_open_at: "2020-01-01T00:00:00Z", submissions_close_at: "2099-01-01T00:00:00Z", current_consent_version: "v0-provisional" }] } }],
      ["sidebar", "nav", { path: "/admin/registrations" }],
    ];
    for (const [name, hash, o] of screens) {
      test(`${name}: no horizontal scroll, every control at least 44px, every text meets AA contrast`, async ({ page }) => {
        test.skip(!css, "needs the built stylesheet: run `npm run build` first");
        await open(page, hash, o);
        const a = await audit(page, "#root");
        expect(a.overflow).toBe(false);
        expect(a.smallTargets).toEqual([]);
        expect(a.lowContrast).toEqual([]);
      });
    }

    test("judges with the one-time password shown (add and reset): no horizontal scroll, every control at least 44px, every text meets AA contrast", async ({ page }) => {
      test.skip(!css, "needs the built stylesheet: run `npm run build` first");
      const ok = { ok: true, email: "new.judge@example.test", password: "Kd7m-Qp3x-Wn8c-Rt5v-Hj2f" };
      await open(page, "judges", { data: judges, provisioning: { enabled: true, secretKey: "ok", ready: true }, authInfo, adminScript: { provision: [ok], reset: [{ ok: true, password: ok.password }] } });
      await page.getByLabel(/Judge name/).fill("New Judge");
      await page.getByLabel(/^Email/).fill("new.judge@example.test");
      await page.getByLabel(/I have confirmed that this e-mail/).check();
      await page.getByRole("button", { name: /Add judge/ }).click();
      await page.getByRole("button", { name: /Reset password Judge Two/ }).click();
      await page.getByRole("button", { name: /Yes, reset/ }).click();
      await expect(page.getByRole("group", { name: /Sign-in details/ })).toHaveCount(2);
      const a = await audit(page, "#root");
      expect(a.overflow).toBe(false);
      expect(a.smallTargets).toEqual([]);
      expect(a.lowContrast).toEqual([]);
      await page.screenshot({ path: `screenshots/provisioning/judges-password-${vp.n}.png`, fullPage: true });
    });
  });
}
