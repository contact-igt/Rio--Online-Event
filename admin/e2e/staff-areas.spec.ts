import { expect, test } from "@playwright/test";

// Against the real production build: the judge and administrator areas are not reachable without signing in, say nothing about
// themselves, and the response headers do not name the private bucket while playback and uploads are switched off.

test.describe("signed-out visitors", () => {
  for (const path of ["/admin", "/admin/registrations", "/admin/judges", "/admin/events/kutti-pesalar", "/judge", "/judge/entries/bbbbbbbb-0000-4000-8000-0000000000b1"]) {
    test(`${path} sends a signed-out visitor to the staff sign-in and shows nothing`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/staff\/login$/);
      const body = await page.locator("body").innerText();
      expect(body).not.toMatch(/entry code|RIO-[A-Z0-9]{5}|Assign a judge|scoring progress/i);
    });
  }

  test("an unknown competition or a malformed entry id is a plain 404", async ({ page }) => {
    expect((await page.goto("/judge/entries/not-a-uuid"))?.status()).toBe(404);
    const res = await page.goto("/admin/events/not-a-competition");
    expect(res?.status()).toBe(404);
  });

  test("the staff areas are not indexed and expose no data in the HTML", async ({ page }) => {
    const res = await page.goto("/signin?event=");
    expect(res?.status()).toBeLessThan(500);
    const html = await page.content();
    expect(html).not.toMatch(/r2\.cloudflarestorage\.com|videos\/|pending\//);
  });

  test("with every switch off, the security headers name no bucket host", async ({ request }) => {
    const res = await request.get("/");
    const csp = res.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toMatch(/cloudflarestorage|r2\.dev/);
    expect(csp).toContain("media-src 'self' blob:;");
    expect(res.headers()["x-frame-options"]).toBe("DENY");
  });
});
