import { expect, test } from "@playwright/test";
import { audit } from "@/e2e/helpers/audit";

// On the real production build: the public Staff Access links, the one staff sign-in, role-based access for signed-out visitors, the
// password page of an invitation, and the development preview being absent in production. No account exists in these tests and nothing
// is created, sent or changed.

test.describe("Staff login icon in the public header", () => {
  test("on a wide screen a small icon button (no Staff Access label) opens a menu with Admin Login and Judge Login", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByText("Staff Access")).toHaveCount(0);
    const button = page.getByRole("button", { name: "Staff login" });
    await expect(button).toHaveAttribute("aria-expanded", "false");
    expect(await button.innerText()).toBe(""); // an icon only, no visible label
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(Math.abs(box.width - box.height)).toBeLessThan(1); // circular
    const content = (await page.locator("header > div").boundingBox())!; // the 1200px column with 32px side padding
    expect(Math.abs(box.x + box.width - (content.x + content.width - 32))).toBeLessThan(2); // at the far right of the header content
    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    const menu = page.getByRole("menu", { name: "Staff login" });
    await expect(menu.getByRole("menuitem")).toHaveCount(2);
    await expect(menu.getByRole("menuitem", { name: /Admin Login/ })).toHaveAttribute("href", "/staff/login?role=admin");
    await expect(menu.getByRole("menuitem", { name: /Judge Login/ })).toHaveAttribute("href", "/staff/login?role=judge");
    const m = (await menu.boundingBox())!;
    expect(Math.abs(m.x + m.width - (box.x + box.width))).toBeLessThan(2); // aligned to the right edge of the button
    expect(await menu.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");
  });

  test("the icon does not make the header taller: it is no taller than the other header controls", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const icon = (await page.getByRole("button", { name: "Staff login" }).boundingBox())!.height;
    const link = (await page.getByRole("navigation", { name: "Main" }).getByRole("link").first().boundingBox())!.height;
    expect(icon).toBeLessThanOrEqual(link);
    expect((await page.locator("header").boundingBox())!.height).toBeLessThan(70); // 44px controls plus padding
    await page.setViewportSize({ width: 360, height: 780 });
    const menu = (await page.getByRole("button", { name: /Menu/ }).boundingBox())!.height;
    expect(icon).toBeLessThanOrEqual(menu); // the two-line Menu button already sets the phone header height
  });

  test("closes on Escape (focus returns to the button), on an outside click and on a second click", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const button = page.getByRole("button", { name: "Staff login" });
    const menu = page.getByRole("menu", { name: "Staff login" });
    await button.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(button).toBeFocused();
    await button.click();
    await page.locator("main").click({ position: { x: 5, y: 5 } });
    await expect(menu).toHaveCount(0);
    await button.click();
    await button.click();
    await expect(menu).toHaveCount(0);
  });

  test("keyboard: Arrow Down opens it on the first item, arrows/Home/End move, Tab leaves and closes, Enter follows the link", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const button = page.getByRole("button", { name: "Staff login" });
    const menu = page.getByRole("menu", { name: "Staff login" });
    await button.focus();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: /Admin Login/ })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: /Judge Login/ })).toBeFocused();
    await page.keyboard.press("ArrowDown"); // wraps
    await expect(menu.getByRole("menuitem", { name: /Admin Login/ })).toBeFocused();
    await page.keyboard.press("ArrowUp"); // wraps back
    await expect(menu.getByRole("menuitem", { name: /Judge Login/ })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(menu.getByRole("menuitem", { name: /Admin Login/ })).toBeFocused();
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem", { name: /Judge Login/ })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(menu).toHaveCount(0);
    await button.focus();
    await page.keyboard.press("ArrowUp"); // opens on the last item
    await expect(menu.getByRole("menuitem", { name: /Judge Login/ })).toBeFocused();
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/staff\/login\?role=admin$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Admin sign-in");
  });

  test("both menu items reach the existing sign-in, which still redirects a signed-out visitor away from staff areas", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "Staff login" }).click();
    await page.getByRole("menuitem", { name: /Judge Login/ }).click();
    await expect(page).toHaveURL(/\/staff\/login\?role=judge$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Judge sign-in");
    for (const path of ["/admin", "/judge"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/staff\/login$/);
    }
  });

  test("the main navigation is unchanged by it: still four links", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveCount(4);
  });

  test("on a phone the same icon sits right of Menu, the Menu has no Staff Access section, and a choice goes to sign-in", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto("/");
    const menuButton = page.getByRole("button", { name: /Menu/ });
    const icon = page.getByRole("button", { name: "Staff login" });
    expect((await icon.boundingBox())!.x).toBeGreaterThan((await menuButton.boundingBox())!.x);
    await menuButton.click();
    await expect(page.locator("#mobile-nav").getByRole("link")).toHaveCount(4);
    await expect(page.locator("#mobile-staff")).toHaveCount(0);
    await expect(page.getByText("Staff Access")).toHaveCount(0);
    await icon.click(); // opening the staff menu closes the phone menu
    await expect(menuButton).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("menuitem")).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("menuitem", { name: /Judge Login/ }).click();
    await expect(page).toHaveURL(/\/staff\/login\?role=judge$/);
  });

  test("login links exist only once on a page: none in the footer, no duplicates", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.locator("footer").getByRole("link", { name: /Admin Login|Judge Login/ })).toHaveCount(0);
    await expect(page.locator('a[href^="/staff/login"]')).toHaveCount(0); // not rendered until the menu is opened
    await page.getByRole("button", { name: "Staff login" }).click();
    await expect(page.locator('a[href^="/staff/login"]')).toHaveCount(2);
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

    test("the header with the staff login menu open has no overflow and enough contrast", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Staff login" }).click();
      const a = await audit(page, "header");
      expect(a.overflow).toBe(false);
      expect(a.lowContrast).toEqual([]);
      expect(a.smallTargets).toEqual([]);
    });

    test("the header with the phone Menu open has no overflow and enough contrast", async ({ page }) => {
      test.skip(vp.w >= 1024, "the phone Menu exists below 1024px");
      await page.goto("/");
      await page.getByRole("button", { name: /Menu/ }).click();
      const a = await audit(page, "header");
      expect(a.overflow).toBe(false);
      expect(a.lowContrast).toEqual([]);
      expect(a.smallTargets).toEqual([]);
    });
  });
}
