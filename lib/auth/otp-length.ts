// The length of the email one-time code. Supabase decides how many digits it issues (Authentication, Providers,
// Email, OTP length: 6 to 10), so the app must expect the same number. It is a server-side setting, RIO_OTP_LENGTH,
// read at request time and handed to the screens that need it. Unset means 6. Anything else that is not a whole number
// from 6 to 10 is a configuration error and sign-in refuses to run (fail closed) instead of guessing.
// Plain TypeScript with no path aliases, so the browser tests and the live harness can import it too.

export const DEFAULT_OTP_LENGTH = 6;
export const MIN_OTP_LENGTH = 6;
export const MAX_OTP_LENGTH = 10;

export class OtpLengthConfigError extends Error {
  override name = "OtpLengthConfigError";
}

// By name, not instanceof, like the Supabase config error: still correct if the module is loaded twice.
export const isOtpLengthConfigError = (e: unknown): boolean => e instanceof Error && e.name === "OtpLengthConfigError";

export function resolveOtpLength(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.RIO_OTP_LENGTH ?? "").trim();
  if (raw === "") return DEFAULT_OTP_LENGTH;
  const n = /^[0-9]{1,2}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < MIN_OTP_LENGTH || n > MAX_OTP_LENGTH) {
    throw new OtpLengthConfigError(`RIO_OTP_LENGTH must be a whole number from ${MIN_OTP_LENGTH} to ${MAX_OTP_LENGTH}.`);
  }
  return n;
}
