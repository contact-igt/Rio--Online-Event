import { z } from "zod";
import { emailSchema } from "@/lib/auth/schemas";

// Staff sign-in answers, as the page shows them. The Express API checks the password and the role; this file only validates the shape of the
// input before it is sent and maps the API's answer to one of five codes. Wrong password, unknown email and a deactivated account all come back
// from the API as the same 401, so the page cannot be used to learn which emails exist.

export type LoginCode = "invalid" | "credentials" | "notStaff" | "tooMany" | "unavailable";

const input = z.object({ email: emailSchema, password: z.string().min(1).max(256) });

export function parseLogin(raw: { email: unknown; password: unknown }): { email: string; password: string } | null {
  const parsed = input.safeParse({ email: raw.email, password: raw.password });
  return parsed.success ? parsed.data : null;
}

export function loginErrorCode(status: number): LoginCode {
  if (status === 401) return "credentials";
  if (status === 429) return "tooMany";
  if (status === 400 || status === 422) return "invalid";
  return "unavailable"; // API down (0), origin refused (403), anything unexpected
}
