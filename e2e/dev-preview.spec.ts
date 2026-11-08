import { expect, test, type Page } from "@playwright/test";
import { audit } from "./helpers/audit";
import { builtCss } from "./helpers/staff-bundle";
import { bundleFixture } from "./fixtures/bundle";

// The development-only registration preview: the real form with realistic empty and error states, and a stand-in for its server action that
// runs the real validation and then does nothing. The browser makes no network request at all. (In a production build the route is a 404:
// see staff-access.spec.ts and app/dev/registration-preview/page.test.tsx.)

let bundle = "";
let css = "";
test.beforeAll(async () => {
  bundle = await bundleFixture("e2e/fixtures/dev-preview-entry.tsx", { "@/app/events/[slug]/register/actions": "e2e/fixtures/fake-save-draft.ts", "next/link": "e2e/fixtures/fake-link.tsx" });
  css = builtCss();
});

async function open(page: Page) {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0;background:#fff8fb"><main id="root" class="wash"></main></body>');
  if (css) await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector("body[data-ready='1'] form");
}

test("shows three states of the real form: empty, with validation errors, and editing a saved draft", async ({ page }) => {
  await open(page);
  await expect(page.locator("form")).toHaveCount(3);
  const [empty, invalid, draft] = [page.locator("form").nth(0), page.locator("form").nth(1), page.locator("form").nth(2)];
  await expect(empty.locator("[role=alert]")).toHaveCount(0);
  await expect(empty.locator("input[name=childName]")).toHaveValue("");
  for (const field of ["childName", "childAge", "parentName", "mobile", "guardianConsent"]) await expect(invalid.locator(`#${field}-error`)).toBeVisible();
  await expect(invalid.locator("#form-error")).toBeVisible();
  await expect(invalid.locator("input[name=mobile]")).toHaveValue("12345");
  await expect(draft.locator("input[name=childName]")).toHaveValue("Sample Child");
  await expect(draft.getByText("Guardian consent given")).toBeVisible();
});

test("submitting the empty form shows the REAL validation errors; a valid form only says nothing was saved or sent", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await open(page);
  const empty = page.locator("form").nth(0);
  await empty.getByRole("button", { name: /Save draft/ }).click();
  for (const field of ["childName", "childAge", "parentName", "mobile", "guardianConsent"]) await expect(empty.locator(`#${field}-error`)).toBeVisible();
  await empty.locator("input[name=childName]").fill("Preview Child");
  await empty.locator("select[name=childAge]").selectOption("9");
  await empty.locator("input[name=parentName]").fill("Preview Parent");
  await empty.locator("input[name=mobile]").fill("9876543210");
  await empty.locator("input[name=guardianConsent]").check();
  await empty.getByRole("button", { name: /Save draft/ }).click();
  await expect(empty.locator("#form-error")).toContainText("Preview only: nothing was saved or sent.");
  expect(requests.filter((u) => !u.startsWith("about:") && !u.startsWith("data:"))).toEqual([]); // no network request of any kind
});

for (const vp of [
  { n: "360", w: 360, h: 780 },
  { n: "390", w: 390, h: 844 },
  { n: "768", w: 768, h: 1024 },
  { n: "1440", w: 1440, h: 900 },
] as const) {
  test(`at ${vp.n}px: no horizontal scroll, every control at least 44px, AA contrast`, async ({ browser }) => {
    test.skip(!css, "needs the built stylesheet: run `npm run build` first");
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, hasTouch: vp.w < 1024, isMobile: vp.w < 768 });
    const page = await ctx.newPage();
    await open(page);
    const a = await audit(page, "#root");
    expect(a.overflow).toBe(false);
    expect(a.smallTargets).toEqual([]);
    expect(a.lowContrast).toEqual([]);
    await ctx.close();
  });
}
