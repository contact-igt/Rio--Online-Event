// Live parent sign-in through the real app and the real Supabase Auth server (dev project only).
//
// NOT part of `npm run test:e2e`. Run with `npm run test:e2e:live` after approval. scripts/db-dev.ts refuses the
// production project, a URL that disagrees with RIO_DEV_PROJECT_REF, and keys of the wrong kind.
//
// It creates ONE dummy auth user (<run>-parent@example.test) with the secret key, gets a real one-time code for it
// from Supabase (auth.admin.generateLink returns the code instead of emailing it), then drives the browser:
// type the code, land on the selected competition, reload (session persistence), open /account, sign out.
// The secret key is used only to create that user, fetch its code, and delete it afterwards. No email is sent, so
// REAL EMAIL DELIVERY IS NOT TESTED HERE (see PROJECT_BRIEF.md, M3A).
//
// STATUS: never executed (UNVERIFIED). Possible difference to check on first run: whether Supabase accepts a code from
// generateLink(type "magiclink") as verifyOtp type "email", which is what the app uses.

import { expect, test } from "@playwright/test";
import { createDummyUser, runId, serviceClient, signInThroughApp } from "./helpers";

const run = runId("m3a");
const email = `${run}-parent@example.test`;
const service = serviceClient();
let userId = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  userId = await createDummyUser(service, email);
});

test.afterAll(async () => {
  if (userId) await service.auth.admin.deleteUser(userId);
});

test("a parent signs in with a real code, keeps the session across reloads, and signs out", async ({ page, context }) => {
  await signInThroughApp(page, context, service, email, "kutti-pesalar");

  // lands on the competition the parent chose, signed in
  await expect(page).toHaveURL(/\/events\/kutti-pesalar\/register$/, { timeout: 20_000 });
  await expect(page.getByText("Registration opens soon").first()).toBeVisible();
  expect((await context.cookies()).some((c) => c.name.startsWith("sb-"))).toBe(true);
  expect((await context.cookies()).some((c) => c.name === "rio_otp" && c.value !== "")).toBe(false); // pending cookie cleared

  // session persistence: reload and a fresh tab in the same browser are still signed in
  await page.reload();
  await expect(page).toHaveURL(/\/events\/kutti-pesalar\/register$/);
  const second = await context.newPage();
  await second.goto("/account");
  await expect(second).toHaveURL(/\/account$/);
  await expect(second.getByText(email)).toBeVisible();
  await second.close();

  // the sign-in page recognises a returning parent
  await page.goto("/signin?event=tamilil-sollu");
  await expect(page).toHaveURL(/\/events\/tamilil-sollu\/register$/);

  // sign out ends this browser's session, and protected pages bounce again
  await page.getByRole("button", { name: /Sign out/ }).click();
  await expect(page).toHaveURL("http://localhost:3100/");
  await page.goto("/account");
  await expect(page).toHaveURL(/\/signin$/);
  expect((await context.cookies()).filter((c) => c.name.startsWith("sb-") && c.value !== "")).toEqual([]);
});

test("the same code cannot be used twice", async ({ page, context }) => {
  await context.addCookies([
    { name: "rio_otp", value: encodeURIComponent(JSON.stringify({ email, sentAt: Date.now() - 61_000 })), domain: "localhost", path: "/signin", httpOnly: true, sameSite: "Lax" },
  ]);
  const { data } = await service.auth.admin.generateLink({ type: "magiclink", email });
  const code = data.properties!.email_otp;
  await page.goto("/signin/verify");
  await page.locator("#code").fill(code);
  await page.getByRole("button", { name: /Verify/ }).click();
  await expect(page).toHaveURL(/\/account$/, { timeout: 20_000 });
  await page.getByRole("button", { name: /Sign out/ }).click();

  await context.addCookies([
    { name: "rio_otp", value: encodeURIComponent(JSON.stringify({ email, sentAt: Date.now() - 61_000 })), domain: "localhost", path: "/signin", httpOnly: true, sameSite: "Lax" },
  ]);
  await page.goto("/signin/verify");
  await page.locator("#code").fill(code);
  await page.getByRole("button", { name: /Verify/ }).click();
  await expect(page.locator("p[role=alert]")).toContainText(/wrong or has expired/, { timeout: 20_000 });
});
