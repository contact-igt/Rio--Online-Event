"use server";

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { sendErrorMessage, verifyErrorMessage } from "@/lib/auth/errors";
import { copy, cooldownMessage, type Msg } from "@/lib/auth/messages";
import { afterSignInPath, signInPath, verifyPath } from "@/lib/auth/paths";
import { secondsLeft } from "@/lib/auth/cooldown";
import { resolveOtpLength } from "@/lib/auth/otp-length";
import { clearPending, readPending, writePending } from "@/lib/auth/pending";
import { sendByEmail, sendByIp, verifyByIpAndEmail } from "@/lib/auth/rate-limit";
import { emailSchema, otpSchema, parseEventSlug } from "@/lib/auth/schemas";
import { isSupabaseConfigError } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

// Sign-in with a one-time email code. Nothing here logs an email address or a code, and no returned
// message depends on whether the email already has an account.

export type FormState = { error?: Msg; fieldError?: Msg; email?: string } | undefined;

async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

const emailKey = (email: string) => createHash("sha256").update(email).digest("hex").slice(0, 16);

async function sendCode(email: string, event: string | null, resend: boolean): Promise<FormState> {
  if (!sendByIp.hit(await clientIp()).allowed || !sendByEmail.hit(emailKey(email)).allowed) {
    return { error: copy.errors.tooMany, email };
  }
  const pending = await readPending();
  if (pending && pending.email === email) {
    const left = secondsLeft(pending.sentAt);
    if (left > 0) return { error: cooldownMessage(left), email };
  }

  let failure: Msg | null = null;
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) failure = sendErrorMessage(error);
  } catch (e) {
    failure = isSupabaseConfigError(e) ? copy.errors.unavailable : copy.errors.sendFailed;
  }
  if (failure) return { error: failure, email };

  await writePending({ email, sentAt: Date.now() });
  redirect(verifyPath(event, resend)); // outside try/catch: redirect() works by throwing
}

export async function requestCode(_prev: FormState, formData: FormData): Promise<FormState> {
  const event = parseEventSlug(formData.get("event"));
  const raw = formData.get("email");
  const email = emailSchema.safeParse(raw);
  if (!email.success) return { fieldError: copy.errors.invalidEmail, email: typeof raw === "string" ? raw : "" };
  return sendCode(email.data, event, false);
}

export async function resendCode(_prev: FormState, formData: FormData): Promise<FormState> {
  const event = parseEventSlug(formData.get("event"));
  const pending = await readPending();
  if (!pending) redirect(signInPath(event));
  return sendCode(pending.email, event, true);
}

export async function verifyCode(_prev: FormState, formData: FormData): Promise<FormState> {
  const event = parseEventSlug(formData.get("event"));
  const pending = await readPending();
  if (!pending) redirect(signInPath(event));

  let length: number;
  try {
    length = resolveOtpLength();
  } catch {
    return { error: copy.errors.unavailable }; // misconfigured: refuse rather than guess the length
  }
  const code = otpSchema(length).safeParse(formData.get("code") ?? "");
  if (!code.success) return { fieldError: copy.errors.invalidCode(length) };

  const key = `${await clientIp()}|${emailKey(pending.email)}`;
  if (!verifyByIpAndEmail.hit(key).allowed) return { error: copy.errors.tooMany };

  let failure: Msg | null = null;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.verifyOtp({ email: pending.email, token: code.data, type: "email" });
    if (error) failure = verifyErrorMessage(error);
    else if (!data.session) failure = copy.errors.signInFailed;
  } catch (e) {
    failure = isSupabaseConfigError(e) ? copy.errors.unavailable : copy.errors.signInFailed;
  }
  if (failure) return { error: failure };

  verifyByIpAndEmail.reset(key);
  await clearPending();
  redirect(afterSignInPath(event));
}

export async function signOut(): Promise<void> {
  try {
    const supabase = await createClient();
    await supabase.auth.signOut({ scope: "local" }); // this browser only; the parent's other devices stay signed in
  } catch {
    // nothing to sign out of if the project is not configured
  }
  redirect("/");
}
