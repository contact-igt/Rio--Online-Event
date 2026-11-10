import { expect, test, type Page } from "@playwright/test";
import { bundleFixture } from "@/e2e/fixtures/bundle";

// Offline browser regression test for the registration form (M3B.2D). It bundles the REAL RegistrationForm and runs it in
// the installed Chrome with a fake server action (e2e/fixtures/fake-save-draft.ts) that uses the real validation. Nothing
// here contacts Supabase, needs a session, or creates anything. It guards one bug: after a failed save the age
// dropdown went back to "Choose" while the text fields kept their values (React resets a form after an action, and a
// <select defaultValue> does not follow the returned values).

let bundle = "";

test.beforeAll(async () => {
  bundle = await bundleFixture("e2e/fixtures/form-entry.tsx", { "@/app/events/[slug]/register/actions": "e2e/fixtures/fake-save-draft.ts" });
});

async function open(page: Page, hash = "") {
  await page.setContent('<div id="root"></div>');
  await page.evaluate((h) => (location.hash = h), hash);
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole("button", { name: /Save/ })).toBeVisible();
}

const age = (page: Page) => page.locator("#childAge");
const save = (page: Page) => page.getByRole("button", { name: /Save/ });
const saved = (page: Page) => page.evaluate(() => window.__saved ?? []);
const alerts = (page: Page) => page.locator("[role=alert], [id$=-error]");

async function fillAll(page: Page, over: { name?: string; mobile?: string; consent?: boolean } = {}) {
  await page.locator("#childName").fill(over.name ?? "Asha Test");
  await age(page).selectOption("10");
  await page.locator("#parentName").fill("Parent Test");
  await page.locator("#mobile").fill(over.mobile ?? "9876543210");
  if (over.consent !== false) await page.locator("input[name=guardianConsent]").check();
}

test.describe("the age choice survives every failed save", () => {
  test("missing guardian consent: age and text are kept, and ticking consent alone is enough to save", async ({ page }) => {
    await open(page);
    await fillAll(page, { consent: false });
    await save(page).click();
    await expect(alerts(page).filter({ hasText: /consent/i }).first()).toBeVisible();
    await expect(age(page)).toHaveValue("10");
    await expect(page.locator("#childName")).toHaveValue("Asha Test");

    await page.locator("input[name=guardianConsent]").check(); // fix the one mistake, do NOT touch the age
    await save(page).click();
    await expect.poll(() => saved(page)).toHaveLength(1);
    expect((await saved(page))[0]).toMatchObject({ childAge: "10", childName: "Asha Test", guardianConsent: "on" });
  });

  test("invalid mobile number: age kept; fix the number and resubmit without re-picking the age", async ({ page }) => {
    await open(page);
    await fillAll(page, { mobile: "12345" });
    await save(page).click();
    await expect(page.locator("#mobile-error")).toBeVisible();
    await expect(age(page)).toHaveValue("10");

    await page.locator("#mobile").fill("9876543210");
    await save(page).click();
    await expect.poll(() => saved(page)).toHaveLength(1);
    expect((await saved(page))[0]).toMatchObject({ childAge: "10", mobile: "9876543210" });
  });

  test("a duplicate registration answer keeps the age; renaming the child and saving works", async ({ page }) => {
    await open(page);
    await fillAll(page, { name: "Duplicate Dee" });
    await age(page).selectOption("12");
    await save(page).click();
    await expect(page.locator("#form-error")).toContainText(/already has a registration/i);
    await expect(age(page)).toHaveValue("12");

    await page.locator("#childName").fill("Another Child");
    await save(page).click();
    await expect.poll(() => saved(page)).toHaveLength(1);
    expect((await saved(page))[0]).toMatchObject({ childAge: "12", childName: "Another Child" });
  });

  test("a save failure from the server keeps every value, including the age", async ({ page }) => {
    await open(page);
    await fillAll(page, { name: "Failing Fay" });
    await age(page).selectOption("9");
    await save(page).click();
    await expect(page.locator("#form-error")).toBeVisible();
    await expect(age(page)).toHaveValue("9");
    await expect(page.locator("#parentName")).toHaveValue("Parent Test");
    await expect(page.locator("#mobile")).toHaveValue("9876543210");
    await expect(page.locator("input[name=guardianConsent]")).toBeChecked();
  });

  test("several failures in a row: the age never changes, and changing it deliberately is kept too", async ({ page }) => {
    await open(page);
    await fillAll(page, { consent: false, mobile: "1" });
    await age(page).selectOption("11");
    for (let i = 0; i < 3; i++) {
      await save(page).click();
      await expect(page.locator("#form-error")).toBeVisible();
      await expect(age(page)).toHaveValue("11");
    }
    await age(page).selectOption("8"); // a deliberate change after an error
    await save(page).click();
    await expect(page.locator("#form-error")).toBeVisible();
    await expect(age(page)).toHaveValue("8");
  });

  test("an age that was never chosen stays on the placeholder and is refused with the age message", async ({ page }) => {
    await open(page);
    await page.locator("#childName").fill("Asha Test");
    await page.locator("#parentName").fill("Parent Test");
    await page.locator("#mobile").fill("9876543210");
    await page.locator("input[name=guardianConsent]").check();
    await save(page).click();
    await expect(page.locator("#childAge-error")).toBeVisible();
    await expect(age(page)).toHaveValue("");
    expect(await saved(page)).toHaveLength(0);
  });

  test("only the competition's ages are offered (8 to 12 here), and ages outside it cannot be saved", async ({ page }) => {
    await open(page);
    const options = await age(page).locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(options).toEqual(["", "8", "9", "10", "11", "12"]);
    await fillAll(page);
    await age(page).evaluate((el) => {
      const o = document.createElement("option"); // a tampered page: the server-side rule must still refuse it
      o.value = "5";
      o.textContent = "5";
      el.appendChild(o);
    });
    await age(page).selectOption("5");
    await save(page).click();
    await expect(page.locator("#childAge-error")).toBeVisible();
    expect(await saved(page)).toHaveLength(0);
  });

  test("editing a draft starts on the saved age, keeps it after an error, and keeps a deliberate change", async ({ page }) => {
    await open(page, "#edit");
    await expect(age(page)).toHaveValue("10");
    await page.locator("#mobile").fill("12");
    await save(page).click();
    await expect(page.locator("#mobile-error")).toBeVisible();
    await expect(age(page)).toHaveValue("10");
    await age(page).selectOption("11");
    await save(page).click();
    await expect(age(page)).toHaveValue("11");
    await page.locator("#mobile").fill("9876543210");
    await save(page).click();
    await expect.poll(() => saved(page)).toHaveLength(1);
    expect((await saved(page))[0]).toMatchObject({ childAge: "11", draftId: "00000000-0000-4000-8000-000000000001" });
  });
});

test.describe("keyboard and phone", () => {
  test("keyboard only: choose the age with the arrow keys, fail, and the choice is still there", async ({ page }) => {
    await open(page);
    await page.locator("#childName").fill("Asha Test");
    await age(page).focus();
    await page.keyboard.press("ArrowDown"); // first real option
    await page.keyboard.press("ArrowDown");
    const chosen = await age(page).inputValue();
    expect(chosen).not.toBe("");
    await page.keyboard.press("Tab");
    await expect(page.locator("#parentName")).toBeFocused();
    await page.keyboard.type("Parent Test");
    await page.keyboard.press("Tab");
    await expect(page.locator("#mobile")).toBeFocused();
    await page.keyboard.type("12"); // too short
    await page.keyboard.press("Enter"); // submits the form from the keyboard
    await expect(page.locator("#mobile-error")).toBeVisible();
    await expect(age(page)).toHaveValue(chosen);
    await page.keyboard.press("Shift+Tab"); // back from the mobile field to the parent name, then the age is reachable
    await page.keyboard.press("Shift+Tab");
    await expect(age(page)).toBeFocused();
    await expect(age(page)).toHaveValue(chosen);
  });

  test.describe("phone-sized touch screen", () => {
    test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });

    test("tap through the form: the age survives an error and the corrected form saves", async ({ page }) => {
      await open(page);
      await fillAll(page, { consent: false });
      await save(page).tap();
      await expect(alerts(page).filter({ hasText: /consent/i }).first()).toBeVisible();
      await expect(age(page)).toHaveValue("10");
      await page.locator("input[name=guardianConsent]").tap();
      await save(page).tap();
      await expect.poll(() => saved(page)).toHaveLength(1);
      expect((await saved(page))[0]).toMatchObject({ childAge: "10" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  });
});
