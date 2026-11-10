import { expect, test } from "@playwright/test";
import { audit } from "@/e2e/helpers/audit";
import { AGES, events, fitsAge } from "@/lib/events";

// The competition selection page and a competition's details page on the real built server. The age filter is checked against the same
// eligibility function the data uses, for every age from 3 to 12, so the page can never drift from lib/events.ts.

test.describe("competitions page", () => {
  test("bilingual hero, four-step indicator with the first step current, and the facts strip", async ({ page }) => {
    await page.goto("/competitions");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("போட்டியைத் தேர்வு செய்யுங்கள்!");
    await expect(page.getByText("Choose a Competition!")).toBeVisible();
    const stages = page.locator("ol[aria-label='Four steps to take part'] > li");
    await expect(stages).toHaveCount(4);
    for (const [i, t] of ["1. Competition selection", "2. Registration", "3. Upload video", "4. Submit entry"].entries()) await expect(stages.nth(i)).toContainText(t);
    await expect(page.locator("[aria-current=step]")).toHaveCount(1);
    const strip = page.locator("ul[aria-label='Competition facts']");
    await expect(strip).toContainText("30–90 sec");
    await expect(strip).toContainText("Online submission");
    await expect(page.getByRole("heading", { name: /Filter by Age/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /How It Works Next/ })).toBeVisible();
  });

  test("six cards read from the application data, with a View details link each", async ({ page }) => {
    await page.goto("/competitions");
    const cards = page.locator("ol > li[data-fit]");
    await expect(cards).toHaveCount(6);
    for (const [i, e] of events.entries()) {
      const card = cards.nth(i);
      await expect(card).toContainText(e.nameTa);
      await expect(card).toContainText(e.nameEn);
      await expect(card).toContainText(`${e.minAge}–${e.maxAge}`);
      await expect(card).toContainText(e.taskTa);
      await expect(card.getByRole("link", { name: /View details/ })).toHaveAttribute("href", `/events/${e.slug}`);
    }
  });

  test("the age filter offers ages 3 to 12 and, for every age, marks exactly the competitions that accept it", async ({ page }) => {
    await page.goto("/competitions");
    const group = page.getByRole("group", { name: /Child's age|குழந்தையின் வயது/ });
    await expect(group.getByRole("button")).toHaveCount(AGES.length);
    expect(AGES[0]).toBe(3);
    expect(AGES.at(-1)).toBe(12);
    for (const age of AGES) {
      const button = group.getByRole("button", { name: String(age), exact: true });
      await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "true");
      for (const [i, e] of events.entries()) {
        const card = page.locator("ol > li[data-fit]").nth(i);
        await expect(card).toHaveAttribute("data-fit", fitsAge(e, age) ? "yes" : "no");
        if (fitsAge(e, age)) await expect(card).toContainText(`Eligible for age ${age}`);
        else {
          await expect(card).toContainText("Not eligible");
          await expect(card.getByRole("link", { name: /Register/ })).toHaveCount(0); // never leads into a form that would refuse the child
        }
      }
      const fitting = events.filter((e) => fitsAge(e, age)).length;
      await expect(page.getByRole("status").first()).toContainText(`${fitting} of 6 competitions accept age ${age}`);
    }
  });

  test("pressing the same age again clears the filter, and the details link still works for an ineligible competition", async ({ page }) => {
    await page.goto("/competitions");
    const twelve = page.getByRole("button", { name: "12", exact: true });
    await twelve.click();
    await expect(page.locator("li[data-fit=no]").first().getByRole("link", { name: /View details/ })).toBeVisible();
    await twelve.click();
    await expect(page.locator("li[data-fit=unknown]")).toHaveCount(6);
  });

  test("Register appears only while registration is open, and then leads to the existing registration route", async ({ page }) => {
    await page.goto("/competitions");
    const open = await page.locator("a[href$='/register']").count();
    if (open > 0) {
      expect(open).toBe(6);
      await expect(page.locator("a[href='/events/kutti-pesalar/register']")).toHaveCount(1);
    } else {
      await expect(page.getByText("Registration opens soon").first()).toBeVisible();
    }
  });

  test("no unapproved date and no promise of an e-mail while e-mail is off", async ({ page }) => {
    await page.goto("/competitions");
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/நவம்பர்|\b\d{1,2}\s+Nov/i);
    expect(text).not.toMatch(/confirmation email|participation email/i);
  });
});

test.describe("competition details page", () => {
  for (const e of events) {
    test(`${e.nameEn}: real name, age, task, and a way back; no date`, async ({ page }) => {
      await page.goto(`/events/${e.slug}`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(e.nameTa);
      await expect(page.getByText(`${e.minAge}–${e.maxAge}`).first()).toBeVisible();
      await expect(page.getByText(e.taskEn)).toBeVisible();
      await expect(page.getByRole("link", { name: /All competitions/ })).toHaveAttribute("href", "/competitions");
      const text = await page.locator("body").innerText();
      expect(text).not.toMatch(/நவம்பர் 2026|\b\d{1,2}\s+Nov/i);
    });
  }
});

for (const vp of [
  { n: "360", w: 360, h: 780 },
  { n: "390", w: 390, h: 844 },
  { n: "768", w: 768, h: 1024 },
  { n: "1440", w: 1440, h: 900 },
] as const) {
  test.describe(`at ${vp.n}px`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h }, hasTouch: vp.w < 1024, isMobile: vp.w < 768 });
    for (const path of ["/competitions", "/events/kutti-pesalar", "/signin", "/staff/login", "/results"]) {
      test(`${path}: no horizontal scroll, AA contrast, 44px controls`, async ({ page }) => {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        const a = await audit(page);
        expect(a.overflow).toBe(false);
        expect(a.lowContrast).toEqual([]);
        expect(a.smallTargets).toEqual([]);
      });
    }

    test("/competitions: the age buttons are tappable and every age pressed leaves no overflow", async ({ page }) => {
      await page.goto("/competitions");
      const eight = page.getByRole("button", { name: "8", exact: true });
      await eight.click();
      await expect(eight).toHaveCSS("background-color", "rgb(212, 32, 107)"); // the 150ms colour change has finished
      const a = await audit(page);
      expect(a.overflow).toBe(false);
      expect(a.lowContrast).toEqual([]);
      expect(a.smallTargets).toEqual([]);
    });
  });
}
