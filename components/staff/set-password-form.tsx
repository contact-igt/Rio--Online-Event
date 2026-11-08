"use client";

import { useActionState, useState } from "react";
import { setPasswordAction } from "@/app/staff/set-password/actions";
import { SubmitButton } from "@/components/auth/submit-button";

// Choose a password. The password is sent only to the server action (and from there to Supabase Auth); it is never put in a URL or shown
// again after an error. The one-time token travels in a hidden field. After "weak", the token is spent and the form carries on in session mode.

const E = {
  invalid: "Enter a password of at least 12 characters.",
  mismatch: "The two passwords are not the same.",
  weak: "Supabase did not accept this password. Choose a longer one that is not common, with a mix of letters and numbers, then try again.",
  linkInvalid: "This link is not valid any more. Ask an administrator for a new invitation.",
  notStaff: "This account does not have staff access.",
  tooMany: "Too many attempts. Wait a few minutes and try again.",
  unavailable: "Not possible right now. Try again.",
} as const;

export function SetPasswordForm({ tokenHash, type }: { tokenHash: string | null; type: "invite" | "recovery" | null }) {
  const [state, action] = useActionState(setPasswordAction, undefined);
  const [visible, setVisible] = useState(false);
  const session = state?.session === true || tokenHash === null;
  const field = visible ? "text" : "password";

  return (
    <form action={action} noValidate className="space-y-5">
      {!session && tokenHash && type && (
        <>
          <input type="hidden" name="tokenHash" value={tokenHash} />
          <input type="hidden" name="type" value={type} />
        </>
      )}
      <div>
        <label htmlFor="new-password" className="block font-semibold text-rio-navy">
          New password <span lang="ta" className="font-medium text-rio-slate">/ புதிய கடவுச்சொல்</span>
        </label>
        <input id="new-password" name="password" type={field} autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} required minLength={12} maxLength={128} aria-describedby="password-help" className="field mt-2" />
        <p id="password-help" className="mt-1 text-sm text-rio-slate">At least 12 characters.</p>
      </div>
      <div>
        <label htmlFor="confirm-password" className="block font-semibold text-rio-navy">
          Repeat the password <span lang="ta" className="font-medium text-rio-slate">/ மீண்டும் உள்ளிடவும்</span>
        </label>
        <input id="confirm-password" name="confirm" type={field} autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} required maxLength={128} className="field mt-2" />
      </div>
      <label className="flex min-h-11 items-center gap-3 font-semibold text-rio-navy">
        <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} className="h-6 w-6 accent-rio-rose" />
        Show the password
      </label>
      {state?.error && (
        <p role="alert" className="font-semibold text-rio-error">
          {E[state.error]}
        </p>
      )}
      <SubmitButton idle={{ en: "Save password", ta: "கடவுச்சொல்லைச் சேமி" }} busy={{ en: "Saving…", ta: "சேமிக்கிறது…" }} />
    </form>
  );
}
