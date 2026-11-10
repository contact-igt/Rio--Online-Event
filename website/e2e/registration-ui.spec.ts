import { readdirSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { audit } from "@/e2e/helpers/audit";
import { bundleFixture } from "@/e2e/fixtures/bundle";

// The registration screens' building blocks (summary, progress, saved entries, confirmation, form sections) with the REAL components in the
// installed Chrome and the built stylesheet, at phone, tablet and desktop widths. No sign-in is needed and nothing is sent anywhere.

let bundle = "";
let css = "";

test.beforeAll(async () => {
  bundle = await bundleFixture("e2e/fixtures/registration-ui-entry.tsx", { "@/app/events/[slug]/register/actions": "e2e/fixtures/fake-save-draft.ts", "next/link": "e2e/fixtures/fake-link.tsx" });
  try {
    css = readdirSync(".next/static/css").filter((f) => f.endsWith(".css")).map((f) => readFileSync(`.next/static/css/${f}`, "utf8")).join("\n");
  } catch {
    css = "";
  }
});

async function open(page: Page, stage = "none") {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0;background:#fff8fb"><main id="root" class="wash"></main></body>');
  if (css) await page.addStyleTag({ content: css });
  await page.evaluate((h) => (location.hash = h), stage);
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole("button", { name: /Save draft/ })).toBeVisible();
}

test.describe("competition summary", () => {
  test("shows the chosen competition's real name, age band, video length, mode and task, with no poster", async ({ page }) => {
    await open(page);
    const summary = page.locator("aside[aria-labelledby=summary-title]");
    await expect(summary).toContainText("குட்டிப் பேச்சாளர்");
    await expect(summary).toContainText("Little Speaker");
    await expect(summary).toContainText("8 – 12 years");
    await expect(summary).toContainText("30 – 90 seconds");
    await expect(summary).toContainText("Online");
    await expect(summary).toContainText("Give a 1-minute speech");
    expect(await page.locator("img").count()).toBe(0);
  });
});

test.describe("draft versus final", () => {
  test("the four progress steps say in words what is done, what is next and what is later", async ({ page }) => {
    const cases: [string, string[]][] = [
      ["none", ["Done", "Next", "Later", "Later"]],
      ["draft", ["Done", "Done", "Next", "Later"]],
      ["uploaded", ["Done", "Done", "Done", "Next"]],
      ["finalized", ["Done", "Done", "Done", "Done"]],
    ];
    for (const [stage, expected] of cases) {
      await open(page, stage);
      const steps = page.locator("section[aria-labelledby=progress-title] ol > li");
      await expect(steps).toHaveCount(4);
      for (const [i, state] of expected.entries()) await expect(steps.nth(i)).toContainText(state);
      for (const [i, name] of ["1. Choose competition", "2. Registration", "3. Upload video", "4. Submit entry"].entries()) await expect(steps.nth(i)).toContainText(name);
      await expect(page.locator("section[aria-labelledby=progress-title] [aria-current=step]")).toHaveCount(stage === "finalized" ? 0 : 1);
    }
  });

  test("each saved entry is labelled in words: a draft and an uploaded entry are 'not submitted yet', only 'Submitted' is final", async ({ page }) => {
    await open(page);
    const items = page.locator("ul > li").filter({ hasText: /Asha|Bala|Chitra/ }).filter({ has: page.locator("p.rounded-full") });
    await expect(items.filter({ hasText: "Asha" })).toContainText("Draft: not submitted yet");
    await expect(items.filter({ hasText: "Bala" })).toContainText("Video uploaded: not submitted yet");
    await expect(items.filter({ hasText: "Chitra" })).toContainText("Submitted: final");
    await expect(items.filter({ hasText: "Chitra" })).not.toContainText("not submitted");
    await expect(items.filter({ hasText: "Asha" })).toContainText("வரைவு: இன்னும் சமர்ப்பிக்கப்படவில்லை");
  });

  test("the success panel shows the reference, status, details and a pending certificate, and never says an e-mail 'was sent'", async ({ page }) => {
    await open(page);
    const withEmail = page.locator("section[aria-labelledby=submitted-title]").first();
    await expect(withEmail).toContainText("Entry submitted");
    await expect(withEmail).toContainText("Thank you for taking part");
    await expect(withEmail).toContainText("Little Speaker");
    await expect(withEmail).toContainText("Asha");
    await expect(withEmail).toContainText("Uploaded successfully");
    await expect(withEmail).toContainText("Submitted");
    await expect(withEmail).toContainText("RIO-AB12C-DE34F");
    await expect(withEmail).toContainText("Registered email");
    await expect(withEmail).toContainText("A confirmation email will be sent to p***@example.org");
    await expect(withEmail).toContainText("Participation certificate: planned, not available yet");
    await expect(withEmail).toContainText("winners announcement date will be confirmed later");
    await expect(withEmail).toContainText("did not agree");
    const without = page.locator("section[aria-labelledby=submitted-title]").nth(1);
    await expect(without).not.toContainText("confirmation email");
    await expect(without).not.toContainText("Reference");
    await expect(without).toContainText("It is not needed to enter the competition");
    for (const panel of [withEmail, without]) {
      expect(await panel.innerText()).not.toMatch(/has been sent|was sent|email sent/i);
      expect(await panel.innerText()).not.toMatch(/announced on|அன்று அறிவிக்கப்படுவார்கள்/i); // no unapproved announcement date (the "Submitted on" date is the real one)
      await expect(panel.getByRole("link", { name: /View competitions/ })).toHaveAttribute("href", "/competitions");
      await expect(panel.getByRole("button")).toHaveCount(0); // no placeholder download or share button
    }
  });

  test("the register call carries the competition, and says plainly when registration is closed", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("link", { name: /Register for this competition/ })).toHaveAttribute("href", "/events/kutti-pesalar/register");
    await expect(page.getByText("Registration opens soon")).toBeVisible();
  });
});

test.describe("form sections, required and optional fields", () => {
  test("child, parent and consent sections; every required field says so in words; guardian consent is required, media sharing is optional", async ({ page }) => {
    await open(page);
    for (const t of ["Child details", "Parent or guardian details", "Consent"]) await expect(page.getByRole("heading", { name: new RegExp(t) })).toBeVisible();
    for (const id of ["childName", "childAge", "parentName", "mobile"]) await expect(page.locator(`label[for=${id}]`)).toContainText("Required");
    await expect(page.getByText(/Fill in everything marked Required/)).toBeVisible();
    const guardian = page.locator("label", { has: page.locator("input[name=guardianConsent]") });
    await expect(guardian).toContainText("Required");
    await expect(guardian.locator("input")).toHaveAttribute("required", "");
    const media = page.locator("label", { has: page.locator("input[name=mediaConsent]") });
    await expect(media).toContainText("Optional");
    await expect(media.locator("input")).not.toHaveAttribute("required", "");
    await expect(media).toContainText("my child can still take part");
  });

  test("the verified e-mail is read-only text with a lock, the age list follows the competition's band, and Save draft is the one submit button", async ({ page }) => {
    await open(page);
    await expect(page.getByText("synthetic@example.test")).toBeVisible();
    await expect(page.locator("input[value='synthetic@example.test']")).toHaveCount(0);
    const options = await page.locator("select#childAge option:not([disabled])").allInnerTexts();
    expect(options).toEqual(["8", "9", "10", "11", "12"]);
    await expect(page.getByRole("button", { name: /Save draft/ })).toHaveCount(1);
    await expect(page.getByText(/After you save the draft, you can upload the video/)).toBeVisible();
  });
});

for (const vp of [
  { name: "360", width: 360, height: 780 },
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1440", width: 1440, height: 900 },
] as const) {
  test.describe(`at ${vp.name}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.width < 1024, isMobile: vp.width < 768 });
    test("no horizontal scroll, long Tamil wraps, every control is at least 44px and every text meets AA contrast", async ({ page }) => {
      test.skip(!css, "needs the built stylesheet: run `npm run build` first");
      await open(page, "draft");
      const a = await audit(page, "#root");
      expect(a.overflow).toBe(false);
      expect(a.smallTargets).toEqual([]);
      expect(a.lowContrast).toEqual([]);
      const cut = await page.evaluate(() => [...document.querySelectorAll("#root *")].filter((e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().right > window.innerWidth + 1).length);
      expect(cut).toBe(0);
    });
  });
}
