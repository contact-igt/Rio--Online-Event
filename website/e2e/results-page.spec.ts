import { readdirSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { bundleFixture } from "@/e2e/fixtures/bundle";

// The public results screen in every state it can be given, with the built stylesheet so layout and contrast are measured for real.
// What the database lets the page see is tested elsewhere (supabase/tests/results.test.ts, lib/results/public.test.ts).

let bundle = "";
let css = "";

test.beforeAll(async () => {
  bundle = await bundleFixture("e2e/fixtures/results-entry.tsx", {});
  try {
    css = readdirSync(".next/static/css").filter((f) => f.endsWith(".css")).map((f) => readFileSync(`.next/static/css/${f}`, "utf8")).join("\n");
  } catch {
    css = "";
  }
});

async function open(page: Page, hash: string) {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0"><main id="root" style="padding:16px"></main></body>');
  if (css) await page.addStyleTag({ content: css });
  await page.evaluate((h) => (location.hash = h), hash);
  await page.addScriptTag({ content: bundle });
}

/** WCAG contrast of an element's text against its first opaque background, with any CSS colour normalised through a canvas. */
async function contrast(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => {
    const toRgb = (c: string) => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.fillStyle = "#000";
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return { r: d[0]!, g: d[1]!, b: d[2]!, a: d[3]! / 255 };
    };
    const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (let n: Element | null = el; n; n = n.parentElement) {
      const c = toRgb(getComputedStyle(n).backgroundColor);
      if (c.a > 0.99) {
        bg = c;
        break;
      }
    }
    const fg = toRgb(getComputedStyle(el).color);
    const [a, b] = [lum(fg), lum(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

test.describe("before publication", () => {
  test("shows only the announcement line: no winner markup, no names, no scheduled time", async ({ page }) => {
    await open(page, "#pending");
    await expect(page.getByText("The winners announcement date will be confirmed later.")).toBeVisible();
    expect(await page.locator("#root").innerText()).not.toMatch(/நவம்பர்|\d{1,2}\s+Nov/i); // no unapproved date
    expect(await page.locator("ol, li, h2").count()).toBe(0);
    expect(await page.locator("#root").innerText()).not.toMatch(/Chitra|Asha|prize|Place/);
  });
  test("an unreadable result says so and shows nothing else", async ({ page }) => {
    await open(page, "#unavailable");
    await expect(page.getByRole("status")).toContainText("Results are unavailable right now");
    expect(await page.locator("ol, li").count()).toBe(0);
  });
  test("published with no confirmed winner says so", async ({ page }) => {
    await open(page, "#none");
    await expect(page.getByText("No winners have been announced yet.")).toBeVisible();
    expect(await page.locator("ol").count()).toBe(0);
  });
});

test.describe("after publication", () => {
  test("lists winners per competition in rank order, with Tamil first and the label when there is one", async ({ page }) => {
    await open(page, "#published");
    const headings = await page.locator("h2").allInnerTexts();
    expect(headings).toHaveLength(2);
    expect(headings[0]).toContain("கதை சொல்லும் குட்டீஸ்");
    expect(headings[1]).toContain("குட்டிப் பேச்சாளர்");
    const first = page.locator("section").first().locator("li");
    await expect(first).toHaveCount(2);
    await expect(first.nth(0)).toContainText("Chitra");
    await expect(first.nth(0)).toContainText("First prize");
    await expect(first.nth(1)).not.toContainText("prize");
    await expect(page.locator("li").nth(2)).toContainText("Asha");
    // the rank is readable by a screen reader, not only shown in a circle
    await expect(first.nth(0).locator(".sr-only")).toContainText("Place");
  });
  test("every text pair meets WCAG AA (4.5:1), measured on the built stylesheet", async ({ page }) => {
    test.skip(!css, "needs the built stylesheet: run `npm run build` first");
    await open(page, "#published");
    for (const selector of ["h2", "li span.text-lg", "li span.text-rio-slate", "li > span:first-child"]) expect(await contrast(page, selector), selector).toBeGreaterThanOrEqual(4.5);
    await open(page, "#pending");
    expect(await contrast(page, "p")).toBeGreaterThanOrEqual(4.5);
  });
});

test.describe("phone-sized screen", () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });
  test("long names and labels wrap inside their cards with no horizontal scroll", async ({ page }) => {
    test.skip(!css, "needs the built stylesheet: run `npm run build` first");
    await open(page, "#published");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const li of await page.locator("li").all()) {
      const box = (await li.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(360);
    }
  });
});
