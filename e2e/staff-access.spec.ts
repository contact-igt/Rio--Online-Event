import { expect, test } from "@playwright/test";
import { audit } from "./helpers/audit";

// On the real production build: the public Staff Access links, the one staff sign-in, role-based access for signed-out visitors, the
// password page of an invitation, and the development preview being absent in production. No account exists in these tests and nothing
// is created, sent or changed.

test.describe("Staff Access in the public navigation", () => {
  test("on a wide screen a Staff Access menu lists Admin Login and Judge Login, both on the existing sign-in page", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const button = page.getByRole("button", { name: /Staff Access/ });
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    const links = page.locator("#staff-access").getByRole("link");
    await expect(links).toHaveCount(2);
    await expect(page.locator("#staff-access").getByRole("link", { name: /Admin Login/ })).toHaveAttribute("href", "/staff/login?role=admin");
    await expect(page.locator("#staff-access").getByRole("link", { name: /Judge Login/ })).toHaveAttribute("href", "/staff/login?role=judge");
    await page.keyboard.press("Escape");
    await expect(button).toHaveAttribute("aria-expanded", "false");
  });

  test("the main navigation is unchanged by it: still four links", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveCount(4);
  });

  test("on a phone the Menu has a separate Staff Access section with both links, and a choice closes the menu", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto("/");
    await page.getByRole("button", { name: /Menu/ }).click();
    const staff = page.locator("#mobile-staff");
    await expect(staff).toContainText("Staff Access");
    await expect(staff.getByRole("link")).toHaveCount(2);
    await expect(page.locator("#mobile-nav").getByRole("link")).toHaveCount(4);
    await staff.getByRole("link", { name: /Judge Login/ }).click();
    await expect(page).toHaveURL(/\/staff\/login\?role=judge$/);
    await expect(page.getByRole("button", { name: /Menu/ })).toHaveAttribute("aria-expanded", "false");
  });

  test("the footer also links to both logins", async ({ page }) => {
    await page.goto("/");
    const footer = page.locator("footer");
    await expect(footer.getByRole("link", { name: "Admin Login" })).toHaveAttribute("href", "/staff/login?role=admin");
    await expect(footer.getByRole("link", { name: "Judge Login" })).toHaveAttribute("href", "/staff/login?role=judge");
  });
});

test.describe("the one staff sign-in", () => {
  test("the role in the address only changes the heading: the same form, the same fields, no sign-up", async ({ page }) => {
    const forms: string[] = [];
    for (const [query, heading] of [["?role=admin", "Admin sign-in"], ["?role=judge", "Judge sign-in"], ["", "Staff sign-in"], ["?role=superuser", "Staff sign-in"], ["?role=admin&role=judge", "Staff sign-in"]] as const) {
      await page.goto(`/staff/login${query}`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
      forms.push(await page.locator("form").evaluate((f) => [...f.querySelectorAll("input,button")].map((e) => `${e.tagName}:${e.getAttribute("name") ?? e.getAttribute("type")}`).join(",")));
    }
    expect(new Set(forms).size).toBe(1);
    expect(forms[0]).toContain("INPUT:email");
    expect(forms[0]).toContain("INPUT:password");
    expect(forms[0]).not.toContain("role"); // the role is never submitted: access comes from the signed-in account's role
    expect(await page.getByRole("link", { name: /sign up|register|create account/i }).count()).toBe(0);
  });

  test("the sign-in page is not indexed", async ({ page }) => {
    await page.goto("/staff/login?role=admin");
    await expect(page.locator("meta[name=robots]")).toHaveAttribute("content", /noindex/);
  });
});

test.describe("signed-out visitors and the administrator routes", () => {
  for (const path of ["/admin/registrations", "/admin/registrations/bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "/admin/judges", "/admin/events/kutti-pesalar"]) {
    test(`${path} sends a signed-out visitor to the staff sign-in and shows no personal data`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/staff\/login$/);
      const body = await page.locator("body").innerText();
      expect(body).not.toMatch(/RIO-[A-Z0-9]{5}|parent email|mobile number|Send invitation|Registrations\n/i);
      expect(await page.getByRole("navigation", { name: "Administration" }).count()).toBe(0); // no sidebar for a visitor
    });
  }

  test("a malformed registration id is a plain 404 before anything is read", async ({ page }) => {
    const res = await page.goto("/admin/registrations/not-a-uuid");
    expect(res?.status()).toBe(404);
    expect(await page.locator("body").innerText()).not.toMatch(/parent|mobile|RIO-/i);
  });

  test("the registrations page answers the same way for any search text, so nothing can be probed while signed out", async ({ page }) => {
    for (const q of ["kavitha", "RIO-AAAAA", "' or 1=1 --"]) {
      await page.goto(`/admin/registrations?q=${encodeURIComponent(q)}`);
      await expect(page).toHaveURL(/\/staff\/login$/);
    }
  });
});

test.describe("the invitation password page", () => {
  test("a link without a valid token, opened by someone who is not signed in as staff, says it is not valid and offers no form", async ({ page }) => {
    for (const url of ["/staff/set-password", "/staff/set-password?token_hash=bad%20token!&type=invite", "/staff/set-password?token_hash=abcdef1234567890&type=magiclink"]) {
      await page.goto(url);
      await expect(page.locator("main [role=alert]")).toContainText("This link is not valid any more");
      await expect(page.locator("form")).toHaveCount(0);
    }
  });

  test("a link with a well-formed token shows the form; opening it uses nothing up and the token is only in a hidden field", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    await page.goto("/staff/set-password?token_hash=abcdef1234567890xyz&type=invite");
    await expect(page.getByLabel("New password / புதிய கடவுச்சொல்")).toBeVisible();
    await expect(page.getByLabel(/Repeat the password/)).toBeVisible();
    await expect(page.locator("input[name=tokenHash]")).toHaveAttribute("type", "hidden");
    await expect(page.getByRole("button", { name: /Save password/ })).toBeVisible();
    expect(requests.some((u) => /supabase/.test(u))).toBe(false); // the browser never talks to Supabase from this page
    expect(await page.locator("input[type=password]").count()).toBe(2);
  });

  test("short or unequal passwords are refused by the server action before any account is touched", async ({ page }) => {
    await page.goto("/staff/set-password?token_hash=abcdef1234567890xyz&type=invite");
    await page.getByLabel("New password / புதிய கடவுச்சொல்").fill("short");
    await page.getByLabel(/Repeat the password/).fill("short");
    await page.getByRole("button", { name: /Save password/ }).click();
    await expect(page.locator("main [role=alert]")).toContainText("at least 12 characters");
    await page.getByLabel("New password / புதிய கடவுச்சொல்").fill("a long enough password 1");
    await page.getByLabel(/Repeat the password/).fill("a different password 12");
    await page.getByRole("button", { name: /Save password/ }).click();
    await expect(page.locator("main [role=alert]")).toContainText("not the same");
    expect(page.url()).not.toMatch(/long(%20|\+| )enough|different(%20|\+| )password|short/); // the typed passwords are not in the address
  });
});

test.describe("the development preview in a production build", () => {
  for (const path of ["/dev/registration-preview", "/dev", "/dev/anything"]) {
    test(`${path} is a plain 404 that renders nothing of the preview`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(404);
      const body = await page.locator("body").innerText();
      expect(body).not.toMatch(/Development preview|Registration form preview|Empty form|Validation errors/);
      expect(await page.locator("form").count()).toBe(0);
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
    for (const path of ["/staff/login?role=admin", "/staff/login?role=judge", "/staff/set-password?token_hash=abcdef1234567890xyz&type=invite", "/staff/set-password"]) {
      test(`${path}: no horizontal scroll, every control at least 44px, AA contrast`, async ({ page }) => {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        const a = await audit(page);
        expect(a.overflow).toBe(false);
        expect(a.lowContrast).toEqual([]);
        expect(a.smallTargets).toEqual([]);
      });
    }

    test("the header with the Staff Access menu open has no overflow and enough contrast", async ({ page }) => {
      await page.goto("/");
      if (vp.w >= 1024) await page.getByRole("button", { name: /Staff Access/ }).click();
      else await page.getByRole("button", { name: /Menu/ }).click();
      const a = await audit(page, "header");
      expect(a.overflow).toBe(false);
      expect(a.lowContrast).toEqual([]);
      expect(a.smallTargets).toEqual([]);
    });
  });
}
