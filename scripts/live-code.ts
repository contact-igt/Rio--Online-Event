// Helpers for the approval-gated live sign-in tests. Plain TypeScript, no ESM-only syntax (Playwright loads it).
// Nothing here ever includes a one-time code in a message: only its length.

/** The code must have exactly the length the app is configured to accept (RIO_OTP_LENGTH). Names only the lengths. */
export function assertOtpLength(code: string, expected: number): string {
  if (!/^[0-9]+$/.test(code) || code.length !== expected) {
    throw new Error(
      `the project issued a ${code.length}-character one-time code (digits only: ${/^[0-9]+$/.test(code)}) but the app is configured to accept exactly ${expected} digits (RIO_OTP_LENGTH). ` +
        "Set RIO_OTP_LENGTH to the project's OTP length. Nothing was submitted.",
    );
  }
  return code;
}

/** Says which layer refused a sign-in, from the app's own message text. Contains no code and no personal data. */
export function describeVerifyFailure(alertText: string, submittedLength: number): string {
  if (/[0-9]+-digit/i.test(alertText)) {
    return `the app's server-side validation refused the shape of the code (the field held ${submittedLength} characters); Supabase Auth was not asked`;
  }
  if (/wrong or has expired/i.test(alertText)) return "Supabase Auth refused the code as wrong or expired";
  if (/too many/i.test(alertText)) return "the app or Supabase Auth rate-limited the attempt";
  return "the sign-in failed after validation (see the page message)";
}
