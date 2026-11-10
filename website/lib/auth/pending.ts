import { cookies } from "next/headers";
import { z } from "zod";
import { emailSchema } from "@/lib/auth/schemas";

// Between "send code" and "verify code" the email address lives in a short-lived httpOnly cookie, not in the
// URL (personal data must never appear in URLs) and not in client JavaScript. It also records when the last
// code was sent, which drives the resend cooldown.

const NAME = "rio_otp";
const TTL_SECONDS = 15 * 60;

const pendingSchema = z.object({ email: emailSchema, sentAt: z.number().int().positive() });
export type Pending = z.infer<typeof pendingSchema>;

export async function readPending(): Promise<Pending | null> {
  const raw = (await cookies()).get(NAME)?.value;
  if (!raw) return null;
  try {
    const parsed = pendingSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writePending(pending: Pending): Promise<void> {
  (await cookies()).set(NAME, JSON.stringify(pending), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/signin",
    maxAge: TTL_SECONDS,
  });
}

export async function clearPending(): Promise<void> {
  (await cookies()).set(NAME, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/signin", maxAge: 0 });
}
