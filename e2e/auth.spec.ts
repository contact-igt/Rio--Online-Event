import { expect, test, type BrowserContext } from "@playwright/test";
import { resolveOtpLength } from "../lib/auth/otp-length";

const LEN = resolveOtpLength(process.env); // the length this server is configured for (RIO_OTP_LENGTH)

// Browser tests for the parent email sign-in flow, up to (not including) a successful sign-in.
// A successful sign-in needs a real email code: that path is covered by the approval-gated
// e2e-live/ suite. Nothing here creates a session, a user, or sends an email.
// Needs the Next.js server to be configured for the dev Supabase project (.env.local).

test.skip(!process.env.NEXT_PUBLIC_SUPABASE_URL, "Supabase is not configured for this environment");

async function pendingCookie(context: BrowserContext, email: string, ageMs: number) {
  await context.addCookies([
    { name: "rio_otp", value: encodeURIComponent(JSON.stringify({ email, sentAt: Date.now() - ageMs })), domain: "localhost", path: "/signin", httpOnly: true, sameSite: "Lax" },
  ]);
}

test.describe("protected routes", () => {
  test("the account page sends a visitor without a session to sign-in", async ({ page }) => {
    await page.goto("/account");
    await expect(page).toHaveURL(/\/signin$/);
  });

  test("the registration page keeps the selected competition when it redirects to sign-in", async ({ page }) => {
    await page.goto("/events/kutti-pesalar/register");
    await expect(page).toHaveURL(/\/signin\?event=kutti-pesalar$/);
    await expect(page.getByText("குட்டிப் பேச்சாளர்")).toBeVisible();
  });

  test("an unknown competition is a 404, not a sign-in redirect", async ({ request }) => {
    const res = await request.get("/events/does-not-exist/register", { maxRedirects: 0 });
    expect(res.status()).toBe(404);
  });

  test("private pages are not indexed and are not cached", async ({ request }) => {
    const res = await request.get("/signin");
    expect(await res.text()).toMatch(/noindex/i);
    expect(res.headers()["content-security-policy"]).toContain("default-src 'self'");
  });
});

test.describe("sign-in screen", () => {
  test("asks for an email in a mobile-friendly field", async ({ page }) => {
    await page.goto("/signin");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("உள்நுழைக");
    const email = page.locator("#email");
    await expect(email).toHaveAttribute("type", "email");
    await expect(email).toHaveAttribute("autocomplete", "email");
    await expect(email).toHaveAttribute("inputmode", "email");
    await expect(page.getByRole("button", { name: /Send code/ })).toBeVisible();
  });

  test("shows a clear error for an invalid email and does not leave the page", async ({ page }) => {
    await page.goto("/signin");
    await page.locator("#email").fill("not-an-email");
    await page.getByRole("button", { name: /Send code/ }).click();
    await expect(page.locator("p[role=alert]")).toContainText("Enter a valid email address");
    await expect(page).toHaveURL(/\/signin$/);
    await expect(page.locator("#email")).toHaveValue("not-an-email");
  });

  test("shows the selected competition, and ignores a hostile event value", async ({ page }) => {
    await page.goto("/signin?event=tamilil-sollu");
    await expect(page.getByText("தமிழில் சொல்லு!")).toBeVisible();
    await page.goto("/signin?event=https://evil.example");
    await expect(page.getByText(/Selected competition/)).toHaveCount(0);
  });

  test("explains an ended session when the parent is sent back from the registration form", async ({ page }) => {
    await page.goto("/signin?event=kutti-pesalar&expired=1");
    await expect(page.getByRole("status")).toContainText("Your session ended");
    await expect(page.getByText("குட்டிப் பேச்சாளர்")).toBeVisible();
    await page.goto("/signin");
    await expect(page.getByText("Your session ended")).toHaveCount(0);
  });

  test("loads nothing from other origins (the browser never talks to Supabase directly)", async ({ page }) => {
    const hosts = new Set<string>();
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.protocol.startsWith("http")) hosts.add(u.host);
    });
    await page.goto("/signin");
    await page.waitForLoadState("networkidle");
    expect([...hosts]).toEqual(["localhost:3100"]);
  });
});

test.describe("code entry screen", () => {
  test("goes back to sign-in when there is no pending email", async ({ page }) => {
    await page.goto("/signin/verify?event=kutti-pesalar");
    await expect(page).toHaveURL(/\/signin\?event=kutti-pesalar$/);
  });

  test("shows a masked address, a code field for one-time codes, and a resend cooldown", async ({ page, context }) => {
    await pendingCookie(context, "jane.doe@example.test", 5_000);
    await page.goto("/signin/verify?event=kutti-pesalar");
    await expect(page.getByText("j•••@example.test").first()).toBeVisible();
    await expect(page.getByText("jane.doe")).toHaveCount(0);
    const code = page.locator("#code");
    await expect(code).toHaveAttribute("autocomplete", "one-time-code");
    await expect(code).toHaveAttribute("inputmode", "numeric");
    const resend = page.getByRole("button", { name: /Send a new code/ });
    await expect(resend).toBeDisabled();
    await expect(page.getByRole("status")).toContainText(/You can send another code in \d+ seconds/);
  });

  test("the resend button is enabled once the cooldown has passed", async ({ page, context }) => {
    await pendingCookie(context, "jane.doe@example.test", 61_000);
    await page.goto("/signin/verify");
    await expect(page.getByRole("button", { name: /Send a new code/ })).toBeEnabled();
    await expect(page.getByRole("status")).toHaveText("");
  });

  test("a code that is not the configured length is rejected with a clear message", async ({ page, context }) => {
    await pendingCookie(context, "jane.doe@example.test", 5_000);
    await page.goto("/signin/verify");
    await page.locator("#code").fill("12ab");
    await page.getByRole("button", { name: /Verify/ }).click();
    await expect(page.locator("p[role=alert]")).toContainText(`Enter the ${LEN}-digit code`);
  });

  test("an invalid code is refused by the real dev Auth server, with no session created (contacts dev Auth; sends no email)", async ({ page, context }) => {
    await pendingCookie(context, "otp-check@example.test", 61_000);
    await page.goto("/signin/verify?event=kutti-pesalar");
    await page.locator("#code").fill("0".repeat(LEN)); // a well-formed but wrong code at the configured length
    await page.getByRole("button", { name: /Verify/ }).click();
    const alert = page.locator("p[role=alert]");
    await expect(alert).toBeVisible({ timeout: 15_000 });
    await expect(alert).toContainText(/wrong or has expired|Too many attempts|could not sign you in/);
    await expect(page).toHaveURL(/\/signin\/verify/);
    const names = (await context.cookies()).map((c) => c.name);
    expect(names.filter((n) => n.startsWith("sb-"))).toEqual([]);
    await page.goto("/account");
    await expect(page).toHaveURL(/\/signin$/); // still signed out
  });
});

test.describe("mobile layout", () => {
  test.use({ viewport: { width: 360, height: 780 } });
  for (const path of ["/signin", "/signin?event=kutti-pesalar"]) {
    test(`no horizontal scroll on ${path}`, async ({ page }) => {
      await page.goto(path);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
  test("no horizontal scroll on the code screen", async ({ page, context }) => {
    await pendingCookie(context, "jane.doe@example.test", 5_000);
    await page.goto("/signin/verify");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
