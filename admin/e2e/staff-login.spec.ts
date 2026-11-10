import { readdirSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { bundleFixture } from "@/e2e/fixtures/bundle";

// The REAL staff sign-in form in the installed Chrome with a fake server action (so no Supabase is contacted), plus the built
// server's pages. Whether Supabase accepts a password is covered by the unit tests; this proves what the person sees and does.

let bundle = "";
let css = "";

test.beforeAll(async () => {
  bundle = await bundleFixture("e2e/fixtures/staff-login-entry.tsx", { "@/app/staff/login/actions": "e2e/fixtures/fake-staff-login.ts" });
  try {
    css = readdirSync(".next/static/css").filter((f) => f.endsWith(".css")).map((f) => readFileSync(`.next/static/css/${f}`, "utf8")).join("\n");
  } catch {
    css = "";
  }
});

type Answer = { error?: string } | "hold";
async function open(page: Page, script: Answer[] = []) {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0"><main id="root" style="padding:16px"></main></body>');
  if (css) await page.addStyleTag({ content: css });
  await page.evaluate((s) => (window.__loginScript = s as Window["__loginScript"]), script);
  await page.addScriptTag({ content: bundle });
}
const email = (p: Page) => p.getByLabel(/^Email/);
const password = (p: Page) => p.locator("#staff-password");
const submit = (p: Page) => p.getByRole("button", { name: /Sign in/ });
const calls = (p: Page) => p.evaluate(() => window.__loginCalls ?? []);

test.describe("the form", () => {
  test("has an email field, a password field, a show button and a sign-in button, English first with Tamil", async ({ page }) => {
    await open(page);
    await expect(email(page)).toBeVisible();
    await expect(password(page)).toBeVisible();
    await expect(page.getByRole("button", { name: /Show/ })).toBeVisible();
    await expect(submit(page)).toContainText("Sign in");
    await expect(submit(page)).toContainText("உள்நுழைக");
    await expect(page.locator("label[for=staff-email]")).toContainText("மின்னஞ்சல்");
    await expect(page.locator("label[for=staff-password]")).toContainText("கடவுச்சொல்");
    // browsers and password managers know what these fields are
    await expect(email(page)).toHaveAttribute("autocomplete", "username");
    await expect(password(page)).toHaveAttribute("autocomplete", "current-password");
    await expect(password(page)).toHaveAttribute("type", "password");
    await expect(email(page)).toHaveAttribute("type", "email");
  });

  test("the password can be shown and hidden again, without losing what was typed", async ({ page }) => {
    await open(page);
    await password(page).fill("my-secret-pass-1");
    const toggle = page.getByRole("button", { name: /Show/ });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(password(page)).toHaveAttribute("type", "text");
    await expect(page.getByRole("button", { name: /Hide/ })).toHaveAttribute("aria-pressed", "true");
    await expect(password(page)).toHaveValue("my-secret-pass-1");
    await page.getByRole("button", { name: /Hide/ }).click();
    await expect(password(page)).toHaveAttribute("type", "password");
    await expect(password(page)).toHaveValue("my-secret-pass-1");
    expect(await calls(page)).toEqual([]); // showing the password sends nothing
  });

  test("Enter in the password field submits once; the request carries the email and a password, and the page address does not change", async ({ page }) => {
    await open(page, [{ error: "credentials" }]);
    const before = page.url();
    await email(page).fill("admin@example.org");
    await password(page).fill("my-secret-pass-1");
    await password(page).press("Enter");
    await expect(page.locator("#staff-error")).toBeVisible();
    expect(await calls(page)).toEqual([{ email: "admin@example.org", passwordLength: 16 }]);
    expect(page.url()).toBe(before); // nothing in the address, and no query string
    expect(page.url()).not.toContain("secret");
  });

  const errors: [string, RegExp][] = [
    ["invalid", /Enter your email and password/],
    ["credentials", /email or password is incorrect/],
    ["notStaff", /does not have staff access/],
    ["tooMany", /Too many attempts/],
    ["unavailable", /unavailable right now/],
  ];
  for (const [code, message] of errors) {
    test(`a refusal (${code}) is explained in English and Tamil, keeps the email, and clears the password`, async ({ page }) => {
      await open(page, [{ error: code }]);
      await email(page).fill("someone@example.org");
      await password(page).fill("my-secret-pass-1");
      await submit(page).click();
      const alert = page.getByRole("alert");
      await expect(alert).toContainText(message);
      await expect(alert).toContainText(/[஀-௿]/);
      await expect(email(page)).toHaveValue("someone@example.org");
      await expect(password(page)).toHaveValue(""); // never put back into the page
      expect(await page.locator("#root").innerHTML()).not.toContain("my-secret-pass-1");
      await expect(email(page)).toHaveAttribute("aria-invalid", "true");
    });
  }

  test("while signing in the button is disabled and says so, so a double click sends one request", async ({ page }) => {
    await open(page, ["hold"]);
    await email(page).fill("admin@example.org");
    await password(page).fill("my-secret-pass-1");
    await submit(page).dblclick();
    await expect(page.getByRole("button", { name: /Signing in/ })).toBeDisabled();
    expect((await calls(page)).length).toBe(1);
    await page.evaluate(() => window.__loginRelease?.());
    await expect(page.getByRole("alert")).toBeVisible();
    expect((await calls(page)).length).toBe(1);
  });

  test("keyboard order is email, password, show/hide, sign in", async ({ page }) => {
    await open(page);
    await email(page).focus();
    await page.keyboard.press("Tab");
    await expect(password(page)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: /Show/ })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(submit(page)).toBeFocused();
  });
});

test.describe("phone-sized screen", () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });
  test("fits without horizontal scroll, controls are at least 44px, and the error text keeps AA contrast", async ({ page }) => {
    test.skip(!css, "needs the built stylesheet: run `npm run build` first");
    await open(page, [{ error: "unavailable" }]);
    await email(page).fill("a-very-long-address-for-a-narrow-phone-screen@example-hospital.org");
    await password(page).fill("my-secret-pass-1");
    await page.getByRole("button", { name: /Show/ }).tap();
    await submit(page).tap();
    await expect(page.getByRole("alert")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const b of await page.getByRole("button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    for (const f of [email(page), password(page)]) expect((await f.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const ratio = await page.getByRole("alert").evaluate((el) => {
      const rgb = (c: string) => {
        const ctx = document.createElement("canvas").getContext("2d")!;
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return { r: d[0]!, g: d[1]!, b: d[2]!, a: d[3]! / 255 };
      };
      const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
        const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      let bg = rgb("#fff");
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = rgb(getComputedStyle(n).backgroundColor);
        if (c.a > 0.99) {
          bg = c;
          break;
        }
      }
      const [a, b] = [lum(rgb(getComputedStyle(el).color)), lum(bg)];
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});

test.describe("the real pages on the built server", () => {
  test("/staff/login shows the form, is not indexed, and has no registration or password reset", async ({ page }) => {
    const res = await page.goto("/staff/login");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Staff sign-in");
    await expect(page.locator("#staff-email")).toBeVisible();
    await expect(page.locator("#staff-password")).toHaveAttribute("type", "password");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    const text = await page.locator("main, body").first().innerText();
    expect(text).not.toMatch(/register|sign up|create account|forgot|reset password/i);
    await expect(page.getByRole("link", { name: /Parent\? Sign in with an email code/ })).toHaveAttribute("href", "/signin");
  });

  for (const path of ["/admin", "/admin/events/kutti-pesalar", "/judge", "/judge/entries/bbbbbbbb-0000-4000-8000-0000000000b1"]) {
    test(`${path} sends a signed-out visitor to /staff/login`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/staff\/login$/);
    });
  }

  test("the parent sign-in is unchanged: an email field and 'Send code', and no password field", async ({ page }) => {
    await page.goto("/signin");
    await expect(page.locator("#email")).toBeVisible();
    await expect(page.getByRole("button", { name: /Send/ })).toBeVisible();
    expect(await page.locator("input[type=password]").count()).toBe(0);
  });
});
