import { copy, type Msg } from "@/lib/auth/messages";

// Maps a Supabase Auth error to a plain-language message. Messages never say whether an email is
// registered, and never include the provider's raw text (which could echo input).
type AuthLikeError = { code?: string; status?: number; message?: string };

const RATE_LIMITED = new Set(["over_email_send_rate_limit", "over_request_rate_limit", "over_sms_send_rate_limit"]);

export function sendErrorMessage(error: AuthLikeError): Msg {
  if (RATE_LIMITED.has(error.code ?? "") || error.status === 429) return copy.errors.tooMany;
  // Our own check already passed, so the address is well formed; Supabase itself refused it (for example a domain it does not accept).
  // Saying "enter a valid email" would be wrong and send people round in circles.
  if (error.code === "email_address_invalid") return copy.errors.emailNotAccepted;
  return copy.errors.sendFailed;
}

export function verifyErrorMessage(error: AuthLikeError): Msg {
  if (RATE_LIMITED.has(error.code ?? "") || error.status === 429) return copy.errors.tooMany;
  if (error.code === "user_banned") return copy.errors.signInFailed;
  // Supabase answers a wrong code and an expired code in the same way (403 "Token has expired or is invalid").
  if (error.code === "otp_expired" || error.status === 403 || error.status === 422 || /expired|invalid/i.test(error.message ?? "")) {
    return copy.errors.wrongOrExpired;
  }
  return copy.errors.signInFailed;
}
