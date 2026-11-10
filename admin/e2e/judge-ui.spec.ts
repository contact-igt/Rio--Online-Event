import type {} from "@/e2e/fixtures/fake-navigation"; // declares the window flags these tests read
import { readdirSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { bundleFixture } from "@/e2e/fixtures/bundle";

// Offline browser tests for the judge screens (M5/M6): the REAL PlaybackPanel and ScoreForm in the installed Chrome with fake
// server actions. The built stylesheet is added when it exists so layout checks are real. Whether the real server accepts a
// request is covered by the Vitest suites; real R2 playback is UNVERIFIED.

let bundle = "";
let css = "";

test.beforeAll(async () => {
  bundle = await bundleFixture("e2e/fixtures/judge-entry.tsx", {
    "@/app/judge/actions": "e2e/fixtures/fake-judge-actions.ts",
    "next/navigation": "e2e/fixtures/fake-navigation.ts",
  });
  try {
    css = readdirSync(".next/static/css").filter((f) => f.endsWith(".css")).map((f) => readFileSync(`.next/static/css/${f}`, "utf8")).join("\n");
  } catch {
    css = "";
  }
});

type Step = { ok: boolean; [k: string]: unknown } | "throw" | "hold";

async function open(page: Page, hash = "", script: { playback?: Step[]; score?: Step[] } = {}) {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root" style="padding:16px"></div>');
  if (css) await page.addStyleTag({ content: css });
  await page.evaluate(({ h, s }) => {
    location.hash = h;
    window.__judgeScript = s as Window["__judgeScript"];
  }, { h: hash, s: script });
  await page.addScriptTag({ content: bundle });
}
const calls = (page: Page) => page.evaluate(() => window.__judgeCalls ?? []);

test.describe("private video", () => {
  test("no video address is in the page until the judge asks; then a link from the server is used", async ({ page }) => {
    await open(page);
    expect(await page.locator("video").count()).toBe(0);
    expect(await page.locator("#root").innerHTML()).not.toMatch(/r2\.test|videos\//); // the rendered page, not the test bundle
    await page.getByRole("button", { name: /Load video/ }).click();
    const video = page.locator("video");
    await expect(video).toHaveAttribute("src", /^https:\/\/r2\.test\/signed-video/);
    await expect(video).toHaveAttribute("controls", "");
    expect(await calls(page)).toEqual([{ fn: "playback", input: { entryId: "bbbbbbbb-0000-4000-8000-0000000000b1" } }]);
    await expect(page.getByRole("button", { name: /Reload video/ })).toBeVisible();
    await expect(page.getByText(/5 minutes/)).toBeVisible();
  });

  test("the request is sent once even if the button is hammered", async ({ page }) => {
    await open(page, "", { playback: ["hold"] });
    const load = page.getByRole("button", { name: /Load video/ });
    await load.dblclick();
    await expect(load).toBeDisabled();
    expect((await calls(page)).length).toBe(1);
    await page.evaluate(() => window.__judgeRelease?.());
    await expect(page.locator("video")).toHaveCount(1);
    expect((await calls(page)).length).toBe(1);
  });

  const failures: [string, RegExp][] = [
    ["notFound", /cannot be shown/],
    ["unavailable", /unavailable right now/],
    ["tooMany", /Too many attempts/],
    ["invalid", /cannot accept this request/],
  ];
  for (const [code, message] of failures) {
    test(`a refusal (${code}) shows a message in both languages and no video`, async ({ page }) => {
      await open(page, "", { playback: [{ ok: false, code }] });
      await page.getByRole("button", { name: /Load video/ }).click();
      await expect(page.locator("#playback-error")).toContainText(message);
      await expect(page.locator("#playback-error")).toContainText(/[஀-௿]/);
      await expect(page.locator("video")).toHaveCount(0);
    });
  }

  test("a dropped connection is explained and Reload works", async ({ page }) => {
    await open(page, "", { playback: ["throw"] });
    await page.getByRole("button", { name: /Load video/ }).click();
    await expect(page.locator("#playback-error")).toContainText("connection dropped");
    await page.getByRole("button", { name: /Load video/ }).click();
    await expect(page.locator("video")).toHaveCount(1);
  });

  test("when playback is switched off there is no button and nothing is requested", async ({ page }) => {
    await open(page, "#off");
    await expect(page.getByText(/playback is switched off/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Load video/ })).toHaveCount(0);
    expect(await calls(page)).toEqual([]);
  });
});

test.describe("scoring", () => {
  test("save a draft, then submit a final score only after a confirmation", async ({ page }) => {
    await open(page);
    await page.getByLabel(/Marks/).fill("72.5");
    await page.getByLabel(/Comments/).fill("Good effort");
    await page.getByRole("button", { name: /Save draft/ }).click();
    await expect(page.getByRole("status")).toContainText("Saved");
    expect((await calls(page)).filter((c) => c.fn === "score")).toEqual([{ fn: "score", input: { entryId: "bbbbbbbb-0000-4000-8000-0000000000b1", marks: "72.5", comments: "Good effort", final: false } }]);

    await page.getByRole("button", { name: /Submit final score/ }).click();
    await expect(page.getByText(/You cannot change a final score/)).toBeVisible();
    expect((await calls(page)).filter((c) => c.fn === "score").length).toBe(1); // asking sends nothing
    await page.getByRole("button", { name: /Cancel/ }).click();
    await expect(page.getByRole("button", { name: /Submit final score/ })).toBeVisible();
    await page.getByRole("button", { name: /Submit final score/ }).click();
    await page.getByRole("button", { name: /Yes, submit my final score/ }).click();
    await expect(page.getByRole("status")).toContainText("Final score saved");
    const scores = (await calls(page)).filter((c) => c.fn === "score");
    expect(scores.at(-1)!.input).toMatchObject({ final: true, marks: "72.5" });
    expect(await page.evaluate(() => window.__refreshed)).toBe(2);
  });

  test("an existing draft is shown and can be changed", async ({ page }) => {
    await open(page, "#draft");
    await expect(page.getByLabel(/Marks/)).toHaveValue("70");
  });

  test("a final score is read-only: no field, no button, and a clear message", async ({ page }) => {
    await open(page, "#final");
    await expect(page.getByText("88.5")).toBeVisible();
    await expect(page.getByText("Clear")).toBeVisible();
    await expect(page.getByText(/This score is final/)).toBeVisible();
    await expect(page.getByLabel(/Marks/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Save draft|Submit final/ })).toHaveCount(0);
  });

  const errors: [string, RegExp][] = [
    ["invalid", /Enter marks from 0 to 100/],
    ["marksRequired", /needs marks/],
    ["locked", /already final/],
    ["notAllowed", /cannot score this entry/],
    ["conflict", /Another save got in the way/],
    ["tooMany", /Too many attempts/],
    ["unavailable", /Could not save right now/],
  ];
  for (const [code, message] of errors) {
    test(`a refusal (${code}) is explained in both languages and keeps what was typed`, async ({ page }) => {
      await open(page, "", { score: [{ ok: false, code }] });
      await page.getByLabel(/Marks/).fill("55");
      await page.getByRole("button", { name: /Save draft/ }).click();
      await expect(page.locator("#score-error")).toContainText(message);
      await expect(page.locator("#score-error")).toContainText(/[஀-௿]/);
      await expect(page.getByLabel(/Marks/)).toHaveValue("55");
      expect(await page.evaluate(() => window.__refreshed ?? 0)).toBe(0);
    });
  }

  test("a final submission is sent once even with a double click on the confirmation", async ({ page }) => {
    await open(page, "", { score: ["hold"] });
    await page.getByLabel(/Marks/).fill("90");
    await page.getByRole("button", { name: /Submit final score/ }).click();
    await page.getByRole("button", { name: /Yes, submit my final score/ }).dblclick();
    expect((await calls(page)).filter((c) => c.fn === "score").length).toBe(1);
    await page.evaluate(() => window.__judgeRelease?.());
    await expect(page.getByRole("status")).toContainText("Final score saved");
  });

  test("the keyboard reaches every control in order", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: /Load video/ }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel(/Marks/)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel(/Comments/)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: /Save draft/ })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: /Submit final score/ })).toBeFocused();
  });
});

test.describe("phone-sized screen", () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });

  test("everything fits without horizontal scroll and the controls are at least 44px", async ({ page }) => {
    test.skip(!css, "needs the built stylesheet: run `npm run build` first");
    await open(page, "", { score: [{ ok: false, code: "conflict" }] });
    await page.getByRole("button", { name: /Load video/ }).tap();
    await expect(page.locator("video")).toBeVisible();
    await page.getByLabel(/Marks/).fill("66");
    await page.getByRole("button", { name: /Save draft/ }).tap();
    await expect(page.locator("#score-error")).toBeVisible();
    await page.getByRole("button", { name: /Submit final score/ }).tap();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const b of await page.getByRole("button").all()) {
      const box = (await b.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    for (const field of [page.getByLabel(/Marks/), page.getByLabel(/Comments/)]) expect((await field.boundingBox())!.width).toBeLessThanOrEqual(360);
  });
});
