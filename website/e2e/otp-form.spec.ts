import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { resolveOtpLength } from "../lib/auth/otp-length";

// Regression tests for the one-time-code form (M3B.2A). They prove WHAT the browser submits and WHICH layer rejects a
// code. Every code here is a made-up number; none is a real code. The server action is never reached when a request is
// intercepted, so these tests contact no Supabase project and create nothing.

// The length comes from the same setting the server uses (RIO_OTP_LENGTH), so these run at 6, 8 or any length from 6 to 10.
const LEN = resolveOtpLength(process.env);
/** A made-up code of the configured length that starts with a zero, to prove leading zeros survive. Index i changes it. */
const synthetic = (i = 0) => `${i}0483920115778899`.slice(0, LEN);

test.skip(!process.env.NEXT_PUBLIC_SUPABASE_URL, "Supabase is not configured for this environment");

async function pendingCookie(context: BrowserContext) {
  await context.addCookies([
    { name: "rio_otp", value: encodeURIComponent(JSON.stringify({ email: "synthetic@example.test", sentAt: Date.now() - 61_000 })), domain: "localhost", path: "/signin", httpOnly: true, sameSite: "Lax" },
  ]);
}

/** The value of the `code` field in a POSTed form (multipart, as React and the browser send it), or null if absent. */
function postedCode(body: string | null): string | null {
  const m = body?.match(/name="(?:_\d+_)?code"\r?\n\r?\n([^\r\n]*)\r?\n/);
  return m ? m[1] : null;
}

/** Records the `code` of every POST to the verify page and stops the request, so the server action never runs. */
function interceptPosts(page: Page): string[] {
  const seen: string[] = [];
  void page.route("**/signin/verify**", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();
    seen.push(postedCode(req.postData()) ?? "<no code field>");
    // a form posted before hydration is a page navigation: answer "no content" so the page stays; a fetch is simply stopped
    return req.resourceType() === "document" ? route.fulfill({ status: 204 }) : route.abort();
  });
  return seen;
}

/** The cooldown has elapsed in these tests, so the resend button only becomes enabled once the page has hydrated. */
async function waitUntilInteractive(page: Page) {
  await expect(page.getByRole("button", { name: /Send a new code/ })).toBeEnabled();
}

test.describe("code field: what is submitted", () => {
  test("the configured number of digits, filled after the form is interactive, is submitted exactly (leading zero kept) as the field named 'code'", async ({ page, context }) => {
    await pendingCookie(context);
    const posts = interceptPosts(page);
    await page.goto("/signin/verify?event=kutti-pesalar");
    await waitUntilInteractive(page);
    await page.locator("#code").fill(synthetic());
    await expect(page.locator("#code")).toHaveValue(synthetic());
    await page.getByRole("button", { name: /Verify/ }).click();
    await expect.poll(() => posts).toEqual([synthetic()]);
    expect(synthetic().startsWith("0")).toBe(true);
  });

  test("typing key by key (as a parent does) submits the same digits, again with the leading zero", async ({ page, context }) => {
    await pendingCookie(context);
    const posts = interceptPosts(page);
    await page.goto("/signin/verify");
    await waitUntilInteractive(page);
    await page.locator("#code").pressSequentially(synthetic(1));
    await page.keyboard.press("Enter");
    await expect.poll(() => posts).toEqual([synthetic(1)]);
  });

  test("filling at once, before the page has hydrated, still submits the typed digits (no lost input)", async ({ page, context }) => {
    await pendingCookie(context);
    const posts = interceptPosts(page);
    for (let i = 0; i < 5; i++) {
      await page.goto("/signin/verify", { waitUntil: "commit" });
      await page.locator("#code").fill(synthetic(i)); // no wait for hydration on purpose
      await page.getByRole("button", { name: /Verify/ }).click();
      await expect.poll(() => posts.length).toBe(i + 1);
      expect(posts[i]).toBe(synthetic(i));
    }
  });
});

test.describe("code field: length handling follows the configured length", () => {
  test("the screen, label and field limit are built from the configured length", async ({ page, context }) => {
    await pendingCookie(context);
    await page.goto("/signin/verify");
    await expect(page.getByText(`${LEN}-digit code`).first()).toBeVisible();
    await expect(page.getByText(`${LEN} இலக்கக் குறியீடு`).first()).toBeVisible();
    await expect(page.locator("#code")).toHaveAttribute("maxlength", String(LEN + 2));
    await page.goto("/signin");
    await expect(page.getByText(`We will email you a ${LEN}-digit code`)).toBeVisible();
    await expect(page.getByText(`${LEN} இலக்கக் குறியீட்டை`)).toBeVisible();
  });

  test("a value one digit too long or too short is refused by the server's validation, before any Supabase call, naming the configured length", async ({ page, context }) => {
    await pendingCookie(context);
    await page.goto("/signin/verify");
    await waitUntilInteractive(page);
    for (const wrong of [synthetic().slice(1), `${synthetic()}7`]) {
      await page.locator("#code").fill(wrong); // fill() ignores maxlength, like a scripted or pasted value
      await page.getByRole("button", { name: /Verify/ }).click();
      await expect(page.locator("p[role=alert]")).toContainText(`Enter the ${LEN}-digit code`);
      await expect(page).toHaveURL(/\/signin\/verify$/);
      await expect(page.locator("#code")).toHaveValue(""); // React resets the form after an action: an empty field does not mean it was empty when sent
    }
  });

  test("a parent cannot type more than the configured length plus two characters", async ({ page, context }) => {
    await pendingCookie(context);
    await page.goto("/signin/verify");
    await waitUntilInteractive(page);
    await page.locator("#code").pressSequentially("04839201157788990011");
    expect((await page.locator("#code").inputValue()).length).toBe(LEN + 2);
  });

  test("the code field fits the screen at 360px for the configured length", async ({ page, context }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await pendingCookie(context);
    await page.goto("/signin/verify");
    await page.locator("#code").fill("0".repeat(LEN));
    const fit = await page.locator("#code").evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(fit.scroll).toBeLessThanOrEqual(fit.client);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
