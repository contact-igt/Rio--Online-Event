import { expect, test } from "@playwright/test";

const slugs = [
  "malalai-mozhi",
  "kathai-sollum-kutties",
  "thirukkural-thiramai",
  "kutti-pesalar",
  "tamil-kalaikoodam",
  "tamilil-sollu",
];

const noHorizontalScroll = () => document.documentElement.scrollWidth <= window.innerWidth;
const allImagesLoaded = () => Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0);

test("home page lists six competitions that link to their routes", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("மழலைத் தமிழே!");
  await expect(page.locator("#competitions ol > li")).toHaveCount(6);
  for (const slug of slugs) await expect(page.locator(`#competitions a[href="/events/${slug}"]`)).toHaveCount(1);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); // the footer logo loads lazily
  await page.waitForLoadState("networkidle");
  expect(await page.evaluate(allImagesLoaded)).toBe(true);
});

for (const slug of slugs) {
  test(`event route /events/${slug} renders`, async ({ page }) => {
    const res = await page.goto(`/events/${slug}`);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Registration opens soon").first()).toBeVisible();
  });
}

test("unknown event returns 404", async ({ page }) => {
  const res = await page.goto("/events/does-not-exist");
  expect(res?.status()).toBe(404);
});

test("age filter on the competitions page marks the fitting competitions", async ({ page }) => {
  await page.goto("/competitions");
  await page.getByRole("button", { name: "5", exact: true }).click();
  await expect(page.getByRole("status").first()).toContainText("3 of 6 competitions accept age 5");
});

test("security headers are present and the old poster is no longer served", async ({ request }) => {
  const res = await request.get("/");
  const h = res.headers();
  expect(h["content-security-policy"]).toContain("default-src 'self'");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBeTruthy();
  expect(h["permissions-policy"]).toBeTruthy();
  expect(h["x-powered-by"]).toBeUndefined();
  const img = await request.get("/images/rio-children-day-poster.jpg");
  expect(img.status()).toBe(404);
});

test.describe("mobile 360px", () => {
  test.use({ viewport: { width: 360, height: 780 } });
  for (const path of ["/", "/competitions", ...slugs.map((s) => `/events/${s}`)]) {
    test(`no horizontal scroll on ${path}`, async ({ page }) => {
      await page.goto(path);
      expect(await page.evaluate(noHorizontalScroll)).toBe(true);
    });
  }
});
