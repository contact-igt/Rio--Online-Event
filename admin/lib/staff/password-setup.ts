import { z } from "zod";

// Choosing a new password. The API enforces the real rules (length, common passwords, the current password); this only checks the shape first.

export type SetPasswordCode = "invalid" | "mismatch" | "weak" | "current" | "tooMany" | "unavailable";

const input = z.object({ current: z.string().min(1).max(256), password: z.string().min(1).max(512), confirm: z.string().max(512) });

export function parsePasswordChange(raw: { current: unknown; password: unknown; confirm: unknown }): { currentPassword: string; newPassword: string } | SetPasswordCode {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return "invalid";
  if (parsed.data.password !== parsed.data.confirm) return "mismatch";
  return { currentPassword: parsed.data.current, newPassword: parsed.data.password };
}

export function passwordErrorCode(status: number, code: string | undefined): SetPasswordCode {
  if (status === 422 || code === "weak_password") return "weak";
  if (status === 403 && code === "current_password_incorrect") return "current";
  if (status === 429) return "tooMany";
  if (status === 400) return "invalid";
  return "unavailable";
}
