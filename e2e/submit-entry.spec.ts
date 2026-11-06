import { readdirSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { bundleFixture } from "./fixtures/bundle";

// Offline browser tests for final submission (M4B). The REAL NextSteps and SubmitEntry run in the installed Chrome; the server
// action is a fake (e2e/fixtures/fake-submit-actions.ts). The built stylesheet is added when it exists so layout checks are
// real. No Supabase, no Cloudflare. Whether the real server accepts the request is covered by the Vitest suites.

let bundle = "";
let css = "";

test.beforeAll(async () => {
  bundle = await bundleFixture("e2e/fixtures/submit-entry.tsx", {
    "@/app/events/[slug]/register/submit-actions": "e2e/fixtures/fake-submit-actions.ts",
    "@/app/events/[slug]/register/video-actions": "e2e/fixtures/fake-video-actions.ts", // NextSteps also renders the upload panel
    "next/navigation": "e2e/fixtures/fake-navigation.ts",
  });
  try {
    css = readdirSync(".next/static/css").filter((f) => f.endsWith(".css")).map((f) => readFileSync(`.next/static/css/${f}`, "utf8")).join("\n");
  } catch {
    css = "";
  }
});

type Step = { ok: boolean; [k: string]: unknown } | "throw" | "hold";

async function open(page: Page, hash = "#on", script: Step[] = []) {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root" style="padding:16px"></div>');
  if (css) await page.addStyleTag({ content: css });
  await page.evaluate(({ h, s }) => {
    location.hash = h;
    window.__submitScript = s as Window["__submitScript"];
  }, { h: hash, s: script });
  await page.addScriptTag({ content: bundle });
}

const calls = (page: Page) => page.evaluate(() => window.__submitCalls ?? []);
const opener = (page: Page) => page.getByRole("button", { name: /Submit entry$/ });
const confirmBtn = (page: Page) => page.getByRole("button", { name: /Yes, submit my final entry|Try again/ });
const back = (page: Page) => page.getByRole("button", { name: /Go back/ });
async function toConfirm(page: Page) {
  await opener(page).click();
  await expect(page.getByRole("heading", { name: /Check before you submit/ })).toBeFocused();
}

test.describe("the submit step", () => {
  test("when final submission is off the button is disabled and no action can be sent", async ({ page }) => {
    await open(page, "#off");
    const disabled = page.getByRole("button", { name: /Submit entry/ });
    await expect(disabled).toBeDisabled();
    await expect(page.getByText("Not open yet").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Yes, submit/ })).toHaveCount(0);
    expect(await calls(page)).toEqual([]);
  });

  test("when on, clicking Submit entry shows a confirmation and sends nothing yet", async ({ page }) => {
    await open(page);
    await toConfirm(page);
    expect(await calls(page)).toEqual([]);
    const review = page.getByRole("region", { name: /Check before you submit/ });
    await expect(review).toContainText("குட்டிப் பேச்சாளர்");
    await expect(review).toContainText("Little Speaker");
    await expect(review).toContainText("Asha");
    await expect(review).toContainText("Age 9");
    await expect(review).toContainText("After you submit, you cannot change this entry or its video. Submitting is final.");
    await expect(review).toContainText(/[஀-௿]/); // Tamil first
  });

  test("Go back and Escape leave the confirmation without sending anything, and focus returns to the opener", async ({ page }) => {
    await open(page);
    await toConfirm(page);
    await back(page).click();
    await expect(opener(page)).toBeFocused();
    await toConfirm(page);
    await page.keyboard.press("Escape");
    await expect(opener(page)).toBeVisible();
    await expect(opener(page)).toBeFocused();
    expect(await calls(page)).toEqual([]);
  });

  test("confirming sends exactly one request carrying only the entry and the competition, then shows the saved state", async ({ page }) => {
    await open(page);
    await toConfirm(page);
    await confirmBtn(page).click();
    await expect(page.getByRole("status")).toContainText("Entry submitted");
    await expect(page.getByRole("status")).toContainText("Your entry is final.");
    await expect(page.getByRole("status")).toContainText("Submitted");
    expect(await calls(page)).toEqual([{ submissionId: "bbbbbbbb-0000-4000-8000-0000000000b1", slug: "kutti-pesalar" }]);
    expect(await page.evaluate(() => window.__refreshed)).toBe(1); // the page is refreshed to show the submitted entry
  });

  test("a double click, and repeated Enter, send ONE request while it is running", async ({ page }) => {
    await open(page, "#on", ["hold"]);
    await toConfirm(page);
    const confirm = confirmBtn(page);
    await confirm.dblclick();
    await expect(page.getByRole("button", { name: /Submitting/ })).toBeDisabled();
    await expect(back(page)).toBeDisabled();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    expect((await calls(page)).length).toBe(1);
    await page.evaluate(() => window.__submitRelease?.());
    await expect(page.getByRole("status")).toContainText("Entry submitted");
    expect((await calls(page)).length).toBe(1);
  });

  test("an entry that was already submitted is answered gently", async ({ page }) => {
    await open(page, "#on", [{ ok: true, already: true }]);
    await toConfirm(page);
    await confirmBtn(page).click();
    await expect(page.getByRole("status")).toContainText("This entry was already submitted.");
  });
});

test.describe("failures keep the entry as it was, explain what happened in both languages, and allow a retry", () => {
  const cases: [string, RegExp][] = [
    ["notFound", /could not find this entry/],
    ["status", /cannot be submitted right now/],
    ["closed", /Registration is closed or has not opened yet/],
    ["locked", /can no longer be changed/],
    ["noVideo", /Upload a video first/],
    ["videoNotVerified", /has not been verified yet/],
    ["videoMissing", /could not find your video/],
    ["videoChanged", /has changed since it was checked/],
    ["videoInvalid", /does not look like a valid video/],
    ["videoDuration", /not between 30 and 90 seconds/],
    ["consent", /guardian consent record is incomplete/],
    ["duplicate", /already has a submitted entry/],
    ["tooMany", /Too many attempts/],
    ["invalid", /cannot accept this request/],
    ["unavailable", /Submission is unavailable right now/],
  ];
  for (const [code, message] of cases) {
    test(`${code}`, async ({ page }) => {
      await open(page, "#on", [{ ok: false, code }]);
      await toConfirm(page);
      await confirmBtn(page).click();
      const error = page.locator("#submit-error");
      await expect(error).toContainText(message);
      await expect(error).toContainText(/[஀-௿]/);
      await expect(page.getByRole("status")).toHaveCount(0); // no success is shown
      expect(await page.evaluate(() => window.__refreshed ?? 0)).toBe(0); // the page was not refreshed to a submitted state
      await expect(page.getByRole("button", { name: /Try again/ })).toBeEnabled();
    });
  }

  test("a dropped connection is explained, and Try again then succeeds with a second request", async ({ page }) => {
    await open(page, "#on", ["throw"]);
    await toConfirm(page);
    await confirmBtn(page).click();
    await expect(page.locator("#submit-error")).toContainText("The connection dropped");
    await page.getByRole("button", { name: /Try again/ }).click();
    await expect(page.getByRole("status")).toContainText("Entry submitted");
    expect((await calls(page)).length).toBe(2);
  });

  test("an unknown failure code still shows the plain unavailable message, never the code", async ({ page }) => {
    await open(page, "#on", [{ ok: false, code: "SELECT secret FROM x" }]);
    await toConfirm(page);
    await confirmBtn(page).click();
    await expect(page.locator("#submit-error")).toContainText("Submission is unavailable right now");
    await expect(page.locator("body")).not.toContainText("SELECT secret");
  });
});

test.describe("the optional media permission is information only", () => {
  test("not given: says the child can still enter, and offers no checkbox or requirement", async ({ page }) => {
    await open(page);
    await toConfirm(page);
    const review = page.getByRole("region", { name: /Check before you submit/ });
    await expect(review).toContainText("you did not agree. Your child can still enter the competition");
    await expect(review.locator('input[type="checkbox"]')).toHaveCount(0);
  });
  test("given: says it is optional and not needed to enter", async ({ page }) => {
    await open(page, "#media");
    await toConfirm(page);
    await expect(page.getByRole("region", { name: /Check before you submit/ })).toContainText(/Optional permission to share: you agreed. It is not needed to enter/);
  });
});

test.describe("keyboard", () => {
  test("Tab order inside the review is: submit, then go back; Enter on submit sends it", async ({ page }) => {
    await open(page);
    await opener(page).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: /Check before you submit/ })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(confirmBtn(page)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(back(page)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toContainText("Entry submitted");
  });
});

test.describe("phone-sized touch screen", () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });

  test("review and confirm by touch with no horizontal scroll and 44px targets", async ({ page }) => {
    test.skip(!css, "needs the built stylesheet: run `npm run build` first");
    await open(page);
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await opener(page).tap();
    await expect(page.getByRole("heading", { name: /Check before you submit/ })).toBeVisible();
    expect(await fits()).toBe(true);
    for (const b of [confirmBtn(page), back(page)]) {
      const box = (await b.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
    await confirmBtn(page).tap();
    await expect(page.getByRole("status")).toContainText("Entry submitted");
    expect(await fits()).toBe(true);
  });

  test("a long error message still fits", async ({ page }) => {
    test.skip(!css, "needs the built stylesheet: run `npm run build` first");
    await open(page, "#on", [{ ok: false, code: "consent" }]);
    await opener(page).tap();
    await confirmBtn(page).tap();
    await expect(page.locator("#submit-error")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
