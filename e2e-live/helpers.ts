// Shared by the approval-gated live specs (dev project only). The secret key is used ONLY here and in the specs'
// setup and cleanup hooks: to create dummy users, fetch their one-time code, change settings for the run, and clean up.
// All permission-relevant behaviour is driven through the real app in a real browser session.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { assertSafeLiveTarget, readProductionPublishableKey, readProductionRef } from "../scripts/live-target";
import { assertOtpLength, describeVerifyFailure } from "../scripts/live-code";
import { timeoutFetch } from "../scripts/live-upload";
import { resolveOtpLength } from "../lib/auth/otp-length";

export const target = assertSafeLiveTarget(process.env, readProductionRef(), readProductionPublishableKey());
/** The same setting the app reads (RIO_OTP_LENGTH, from .env.local); the harness never has its own idea of the length. */
export const otpLength = resolveOtpLength(process.env);
export const runId = (prefix: string) => `${prefix}${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

/** Every request a live suite makes to Supabase is bounded, so a stalled network fails that request fast instead of hanging a hook. */
const REQUEST_TIMEOUT_MS = 30_000;

export function serviceClient(): SupabaseClient {
  return createClient(target.url, target.secretKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timeoutFetch(REQUEST_TIMEOUT_MS) } });
}

/** Creates a confirmed dummy user (no password) and returns its id. */
export async function createDummyUser(service: SupabaseClient, email: string): Promise<string> {
  const { data, error } = await service.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  return data.user.id;
}

/**
 * Signs the dummy user in through the real app: the app's pending-code cookie is set (as after "send code"), a real
 * one-time code is fetched from Supabase instead of an inbox, and typed into the real screen. The code is never logged.
 */
export async function signInThroughApp(page: Page, context: BrowserContext, service: SupabaseClient, email: string, event: string | null) {
  await context.addCookies([
    { name: "rio_otp", value: encodeURIComponent(JSON.stringify({ email, sentAt: Date.now() - 61_000 })), domain: "localhost", path: "/signin", httpOnly: true, sameSite: "Lax" },
  ]);
  const { data, error } = await service.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.email_otp) throw new Error(`could not get a one-time code: ${error?.message}`);
  const code = assertOtpLength(data.properties.email_otp, otpLength); // fails here, naming only the lengths, before anything is typed
  await page.goto(event ? `/signin/verify?event=${event}` : "/signin/verify");
  // The resend button is only enabled after the page has hydrated (the cooldown set above has already elapsed), so this
  // waits for the real, interactive form before typing.
  await expect(page.getByRole("button", { name: /Send a new code/ })).toBeEnabled();
  const field = page.locator("#code");
  await field.fill(code);
  await expect(field).toHaveValue(code); // the field holds exactly the digits; compared, never printed
  await page.getByRole("button", { name: /Verify/ }).click();
  const alert = page.locator("p[role=alert]");
  const outcome = await Promise.race([
    page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 15_000 }).then(() => "signed-in" as const),
    alert.waitFor({ timeout: 15_000 }).then(() => "refused" as const),
  ]).catch(() => "timeout" as const);
  if (outcome === "refused") throw new Error(`sign-in refused: ${describeVerifyFailure((await alert.first().innerText()).replace(/\s+/g, " "), code.length)}`);
  if (outcome === "timeout") throw new Error("sign-in neither completed nor showed an error within 15 seconds");
}

/**
 * A real signed-in session for a dummy user, as a Supabase client that carries that user's JWT. The code is obtained
 * from Supabase (instead of an inbox) and verified through the normal verifyOtp route, so what this client can read or
 * write is decided by row level security exactly as for a parent in a browser. Used for permission assertions.
 */
export async function userSession(service: SupabaseClient, email: string): Promise<SupabaseClient> {
  const { data, error } = await service.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.email_otp) throw new Error(`could not get a one-time code: ${error?.message}`);
  const client = createClient(target.url, target.publishableKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timeoutFetch(REQUEST_TIMEOUT_MS) } });
  const verified = await client.auth.verifyOtp({ email, token: assertOtpLength(data.properties.email_otp, otpLength), type: "email" });
  if (verified.error || !verified.data.session) throw new Error(`could not start a user session: ${verified.error?.message}`);
  return client;
}
