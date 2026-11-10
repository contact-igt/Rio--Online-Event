import { readdirSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { audit } from "@/e2e/helpers/audit";
import { bundleFixture } from "@/e2e/fixtures/bundle";

// The REAL registration page (a server component called as a plain function) for every state a parent can be in, in the installed Chrome
// with the built stylesheet. The server modules are fakes, so nothing is saved, uploaded or sent. What the real server accepts is covered
// by the Vitest suites; this file checks what the parent sees and that the layout holds on every screen size.

let bundle = "";
let css = "";
const DEPS = "e2e/fixtures/fake-register-deps.ts";

test.beforeAll(async () => {
  bundle = await bundleFixture("e2e/fixtures/register-page-entry.tsx", {
    "@/lib/auth/session": DEPS,
    "@/lib/supabase/server": DEPS,
    "@/lib/registration/settings": DEPS,
    "@/lib/registration/drafts": DEPS,
    "@/lib/email/config": DEPS,
    "@/app/signin/actions": DEPS,
    "@/lib/upload/server": DEPS,
    "@/lib/submit/server": DEPS,
    "@/app/events/[slug]/register/actions": "e2e/fixtures/fake-save-draft.ts",
    "@/app/events/[slug]/register/video-actions": "e2e/fixtures/fake-video-actions.ts",
    "@/app/events/[slug]/register/submit-actions": "e2e/fixtures/fake-submit-actions.ts",
    "next/navigation": "e2e/fixtures/fake-navigation.ts",
    "next/link": "e2e/fixtures/fake-link.tsx",
  });
  try {
    css = readdirSync(".next/static/css").filter((f) => f.endsWith(".css")).map((f) => readFileSync(`.next/static/css/${f}`, "utf8")).join("\n");
  } catch {
    css = "";
  }
});

async function open(page: Page, state: string) {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0;background:#fff8fb"><main id="root" class="wash"></main></body>');
  if (css) await page.addStyleTag({ content: css });
  await page.evaluate((h) => (location.hash = h), state);
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector("body[data-ready='1'] h1");
}
const progress = (page: Page) => page.locator("section[aria-labelledby=progress-title] ol > li");

test.describe("a new registration", () => {
  test("shows the chosen competition, the four steps with Registration next, and the form in three sections with one Save draft button", async ({ page }) => {
    await open(page, "new");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("குட்டிப் பேச்சாளர்");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Little Speaker");
    await expect(page.locator("aside[aria-labelledby=summary-title]")).toContainText("8 – 12 years");
    await expect(progress(page).nth(1)).toContainText("Next");
    for (const t of ["Child details", "Parent or guardian details", "Consent"]) await expect(page.getByRole("heading", { name: new RegExp(t) })).toBeVisible();
    await expect(page.getByRole("button", { name: /Save draft/ })).toHaveCount(1);
    await expect(page.getByRole("link", { name: /Continue to upload/ })).toHaveCount(0); // nothing to continue to before a draft exists
    await expect(page.getByText("parent.test@example.test")).toBeVisible(); // the verified e-mail, read-only
    expect(await page.locator("img").count()).toBe(0); // no poster, no picture
  });

  test("the age list follows the competition's band and guardian consent is required while media sharing is optional", async ({ page }) => {
    await open(page, "new");
    expect(await page.locator("select#childAge option:not([disabled])").allInnerTexts()).toEqual(["8", "9", "10", "11", "12"]);
    await expect(page.locator("input[name=guardianConsent]")).toHaveAttribute("required", "");
    await expect(page.locator("input[name=mediaConsent]")).not.toHaveAttribute("required", "");
  });

  test("the upload and submit steps are visibly not open yet, with no working button", async ({ page }) => {
    await open(page, "new");
    const next = page.locator("section[aria-labelledby=next-steps]");
    await expect(next.getByRole("button", { name: /Upload video/ })).toBeDisabled();
    await expect(next.getByRole("button", { name: /Submit entry/ })).toBeDisabled();
  });
});

test.describe("a saved draft", () => {
  test("is labelled 'not submitted yet', offers Continue to upload and the upload panel, and keeps final submission disabled", async ({ page }) => {
    await open(page, "draft");
    await expect(page.getByText("Draft: not submitted yet")).toBeVisible();
    await expect(progress(page).nth(1)).toContainText("Done");
    await expect(progress(page).nth(2)).toContainText("Next");
    await expect(page.getByRole("link", { name: /Continue to upload/ })).toHaveAttribute("href", "#next-steps");
    await expect(page.getByText("Choose a video", { exact: true })).toBeVisible();
    await expect(page.locator("section[aria-labelledby=next-steps]").getByRole("button", { name: /Submit entry/ })).toBeDisabled();
    await expect(page.getByText("Entry submitted")).toHaveCount(0);
  });
});

test.describe("an uploaded entry", () => {
  test("is still 'not submitted yet' and offers the final Submit entry button", async ({ page }) => {
    await open(page, "uploaded");
    await expect(page.getByText("Video uploaded: not submitted yet")).toBeVisible();
    await expect(progress(page).nth(3)).toContainText("Next");
    await expect(page.locator("section[aria-labelledby=next-steps]").getByRole("button", { name: /Submit entry/ })).toBeEnabled();
    await expect(page.getByText("Entry submitted")).toHaveCount(0);
  });
});

test.describe("a submitted entry", () => {
  test("shows the clean success summary: all four steps done, details, reference, pending certificate, and no claim that an e-mail was sent", async ({ page }) => {
    await open(page, "finalized");
    await expect(progress(page).filter({ hasText: "Done" })).toHaveCount(4);
    const panel = page.locator("section[aria-labelledby=submitted-title]");
    await expect(panel).toContainText("Entry submitted");
    await expect(panel).toContainText("Test Child");
    await expect(panel).toContainText("RIO-TEST1-00001");
    await expect(panel).toContainText("Uploaded successfully");
    await expect(panel).toContainText("Participation certificate: planned, not available yet");
    await expect(panel).toContainText("winners announcement date will be confirmed later");
    await expect(panel).toContainText("p•••@example.test"); // the parent's own address, masked
    const text = await panel.innerText();
    expect(text).not.toMatch(/has been sent|was sent|email sent|confirmation email/i); // e-mail is off in this test
    await expect(page.locator("form input[name=childName]")).toHaveCount(0); // a submitted entry cannot be edited
  });
});

test.describe("registration closed", () => {
  test("says plainly that registration has not opened, and offers no form, no steps and no upload", async ({ page }) => {
    await open(page, "closed");
    await expect(page.getByText("Registration has not opened yet")).toBeVisible();
    await expect(page.locator("form input[name=childName]")).toHaveCount(0);
    await expect(progress(page)).toHaveCount(0);
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
    for (const state of ["new", "draft", "uploaded", "finalized", "closed"]) {
      test(`${state}: no horizontal scroll, every control at least 44px, every text meets AA contrast`, async ({ page }) => {
        test.skip(!css, "needs the built stylesheet: run `npm run build` first");
        await open(page, state);
        const a = await audit(page, "#root");
        expect(a.overflow).toBe(false);
        expect(a.smallTargets).toEqual([]);
        expect(a.lowContrast).toEqual([]);
      });
    }
  });
}
