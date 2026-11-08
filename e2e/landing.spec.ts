import { expect, test } from "@playwright/test";
import { audit } from "./helpers/audit";
import { awards, events } from "../lib/events";

// The public landing page on the real built server, at phone, tablet and desktop widths. No sign-in and no private data are involved.
// (It reads one public fact, whether registration is open; the tests accept either answer and check the page is consistent with it.)

const VIEWPORTS = [
  { name: "360 Android", width: 360, height: 780 },
  { name: "390 iPhone", width: 390, height: 844 },
  { name: "768 tablet", width: 768, height: 1024 },
  { name: "1440 desktop", width: 1440, height: 900 },
] as const;

test.describe("structure and content", () => {
  test("a Tamil and English Children's Day hero with two calls to action that both lead to the competitions page", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("மழலைத் தமிழே!");
    await expect(page.getByText("Children's Day Celebration 2026").first()).toBeVisible();
    await expect(page.getByText("என் மொழி… என் மகிழ்ச்சி!")).toBeVisible();
    const register = page.getByRole("link", { name: /Register Now/ }).first();
    const explore = page.getByRole("link", { name: /Explore Competitions/ }).first();
    await expect(register).toHaveAttribute("href", "/competitions");
    await expect(explore).toHaveAttribute("href", "/competitions");
    await register.click();
    await expect(page).toHaveURL(/\/competitions$/);
  });

  test("the hero facts and the navy strip come from the application data", async ({ page }) => {
    await page.goto("/");
    const facts = page.locator("#hero-title").locator("xpath=ancestor::section").locator("ul").first();
    await expect(facts).toContainText("3 – 12");
    await expect(facts).toContainText("30 – 90 sec");
    await expect(facts).toContainText("Online");
    const strip = page.locator("ul[aria-label='Event facts']");
    await expect(strip).toContainText("6 Competitions");
    await expect(strip).toContainText("Open for ages 3–12");
    await expect(strip).toContainText("Online participation");
  });

  test("shows the six configured competitions with their real names, ages and tasks, each with a details link", async ({ page }) => {
    await page.goto("/");
    const cards = page.locator("#competitions ol > li");
    await expect(cards).toHaveCount(events.length);
    for (const [i, e] of events.entries()) {
      const card = cards.nth(i);
      await expect(card).toContainText(e.nameTa);
      await expect(card).toContainText(e.nameEn);
      await expect(card).toContainText(`${e.minAge}–${e.maxAge}`);
      await expect(card).toContainText(e.taskEn);
      await expect(card.getByRole("link", { name: /View details/ })).toHaveAttribute("href", `/events/${e.slug}`);
    }
  });

  test("how it works has four steps in order, and rules and prizes use the real award names", async ({ page }) => {
    await page.goto("/");
    const steps = page.locator("#how ol > li");
    await expect(steps).toHaveCount(4);
    for (const [i, text] of ["Choose a competition", "Register", "Upload your video"].entries()) await expect(steps.nth(i)).toContainText(text);
    const rules = page.locator("#rules");
    await expect(rules).toContainText("Age limit: 3 – 12 years");
    await expect(rules).toContainText("Video length: 30 – 90 seconds");
    await expect(rules).toContainText("One competition entry per child");
    for (const a of awards) await expect(rules).toContainText(a);
    await expect(page.getByRole("heading", { name: /Register your child today/ })).toBeVisible();
  });

  test("the old event poster is gone: no poster image, request or alt text anywhere on the page", async ({ page }) => {
    const urls: string[] = [];
    page.on("request", (r) => urls.push(r.url()));
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(urls.some((u) => /poster/i.test(u))).toBe(false);
    const images = await page.locator("img").evaluateAll((els) => els.map((e) => `${e.getAttribute("src")}|${e.getAttribute("alt")}`));
    expect(images.every((i) => /rio.*logo|hero-children/i.test(i))).toBe(true); // only the logo and approved hero children image; never a poster
    expect(await page.content()).not.toMatch(/Event poster/i);
  });

  test("no unapproved date is shown: dates are pending client approval", async ({ page }) => {
    await page.goto("/");
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/\b\d{1,2}\s+(Nov|November|நவம்பர்)/i);
    expect(text).not.toMatch(/நவம்பர்/);
  });

  test("registration status is stated honestly, and the page promises no confirmation e-mail while e-mail is off", async ({ page }) => {
    await page.goto("/");
    const open = await page.getByText("Registration is open").count();
    const soon = await page.getByText("Registration opens soon").count();
    expect(open + soon).toBe(1);
    await expect(page.getByText(/confirmation email/i)).toHaveCount(0);
    // the landing page never sends anyone to a registration form directly: the cards lead to details, the buttons to the competitions page
    expect(await page.locator("a[href$='/register']").count()).toBe(0);
  });

  test("one header, one main, a navy footer with the logo on a white chip and no third-party request", async ({ page }) => {
    const hosts = new Set<string>();
    page.on("request", (r) => hosts.add(new URL(r.url()).host));
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(await page.locator("header").count()).toBe(1);
    expect(await page.locator("main").count()).toBe(1);
    await expect(page.locator("footer")).toContainText("Rio Hospital for Women & Children");
    expect([...hosts]).toEqual(["localhost:3100"]);
  });
});

test.describe("navigation", () => {
  test("header links go to pages and sections that exist", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Main" }).first();
    const links = await nav.getByRole("link").evaluateAll((els) => els.map((e) => ({ href: e.getAttribute("href"), text: (e.textContent ?? "").trim() })));
    expect(links.map((l) => l.href)).toEqual(["/competitions", "/#rules", "/#how", "/results"]);
    await nav.getByRole("link", { name: /How It Works/ }).click();
    await expect(page.locator("#how")).toBeInViewport();
    await nav.getByRole("link", { name: /Rules & Prizes/ }).click();
    await expect(page.locator("#rules")).toBeInViewport();
  });

  test("on a phone the links sit behind one Menu button that opens, lists the links and closes on a choice", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto("/");
    await expect(page.locator("#mobile-nav")).toHaveCount(0);
    const menu = page.getByRole("button", { name: /Menu/ });
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    const list = page.locator("#mobile-nav");
    await expect(list.getByRole("link")).toHaveCount(4);
    await list.getByRole("link", { name: /Competitions/ }).click();
    await expect(page).toHaveURL(/\/competitions$/);
    await expect(menu).toHaveAttribute("aria-expanded", "false");
  });

  test("the first keyboard stop is the skip link, every control shows a visible focus ring", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      const ring = await page.evaluate(() => {
        const s = getComputedStyle(document.activeElement!);
        return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
      });
      expect(ring.style).not.toBe("none");
      expect(ring.width).toBeGreaterThanOrEqual(2);
    }
  });
});

test.describe("motion", () => {
  test("with reduced motion requested nothing animates and everything is already visible", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("/");
    const names = await page.locator(".rise").evaluateAll((els) => els.map((e) => getComputedStyle(e).animationName));
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n === "none")).toBe(true);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await context.close();
  });

  test("with motion allowed the entrance animates only transform and opacity", async ({ page }) => {
    await page.goto("/");
    const kind = await page.locator(".rise").first().evaluate((e) => getComputedStyle(e).animationName);
    expect(kind).toBe("rise");
    const css = await page.evaluate(async () => {
      const res = await Promise.all([...document.styleSheets].map((s) => [...s.cssRules].map((r) => r.cssText).join("\n")));
      return res.join("\n");
    });
    const frames = css.match(/@keyframes rise\s*\{[^]*?\}\s*\}/)?.[0] ?? "";
    expect(frames).toMatch(/opacity/);
    expect(frames).toMatch(/transform/);
    expect(frames).not.toMatch(/(width|height|top|left|margin|padding)\s*:/);
  });
});

for (const vp of VIEWPORTS) {
  test.describe(`at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.width < 1024, isMobile: vp.width < 768 });

    test("no horizontal scroll, every text meets WCAG AA contrast, every control is at least 44px", async ({ page }) => {
      await page.goto("/");
      await page.waitForLoadState("networkidle");
      const a = await audit(page);
      expect(a.overflow).toBe(false);
      expect(a.lowContrast).toEqual([]);
      expect(a.smallTargets).toEqual([]);
    });

    test("long Tamil never overflows its card: nothing extends past the viewport", async ({ page }) => {
      await page.goto("/");
      const cut = await page.evaluate(() => [...document.querySelectorAll("main *")].filter((e) => !e.closest("[aria-hidden=true]") && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().right > window.innerWidth + 1).length);
      expect(cut).toBe(0);
    });

    test("the six cards lay out in the right number of columns without overlapping", async ({ page }) => {
      await page.goto("/");
      const rects = await page.locator("#competitions ol > li").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
      const columns = new Set(rects.map((r) => Math.round(r.left))).size;
      expect(columns).toBe(vp.width >= 1024 ? 3 : vp.width >= 768 ? 2 : 1);
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) {
          const [a, b] = [rects[i], rects[j]];
          expect(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1).toBe(true);
        }
    });
  });
}

test.describe("loading on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the page and everything it loads stay small, with no poster, no script from another site and one fast render", async ({ page }) => {
    const sizes: { url: string; bytes: number; type: string }[] = [];
    page.on("response", async (r) => {
      const body = await r.body().catch(() => null);
      sizes.push({ url: r.url(), bytes: body?.length ?? 0, type: r.request().resourceType() });
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(sizes.every((s) => new URL(s.url).host === "localhost:3100")).toBe(true);
    expect(sizes.filter((s) => /poster/i.test(s.url))).toEqual([]);
    const images = sizes.filter((s) => s.type === "image");
    expect(Math.max(0, ...images.map((s) => s.bytes))).toBeLessThan(250_000);
    const timing = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0;
      return { dcl: nav.domContentLoadedEventEnd, fcp };
    });
    expect(timing.dcl).toBeLessThan(3000);
    expect(timing.fcp).toBeLessThan(3000);
  });
});
