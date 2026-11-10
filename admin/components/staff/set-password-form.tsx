"use client";

import { useActionState, useState } from "react";
import { setPasswordAction } from "@/app/staff/set-password/actions";
import { SubmitButton } from "@/components/auth/submit-button";

// Choose a password. The passwords are sent only to the server action (and from there to the API); never put in a URL or shown again after an error.

const E = {
  invalid: "Fill in all three fields.",
  mismatch: "The two new passwords are not the same.",
  weak: "This password was not accepted. Use at least 12 characters and avoid common passwords, then try again.",
  current: "The current password is incorrect.",
  tooMany: "Too many attempts. Wait a few minutes and try again.",
  unavailable: "Not possible right now. Try again.",
} as const;

export function SetPasswordForm() {
  const [state, action] = useActionState(setPasswordAction, undefined);
  const [visible, setVisible] = useState(false);
  const field = visible ? "text" : "password";
  const common = { autoCapitalize: "none", autoCorrect: "off", spellCheck: false, required: true } as const;

  return (
    <form action={action} noValidate className="space-y-5">
      <div>
        <label htmlFor="current-password" className="block font-semibold text-rio-navy">
          Current password <span lang="ta" className="font-medium text-rio-slate">/ தற்போதைய கடவுச்சொல்</span>
        </label>
        <input id="current-password" name="current" type={field} autoComplete="current-password" maxLength={256} {...common} className="field mt-2" />
      </div>
      <div>
        <label htmlFor="new-password" className="block font-semibold text-rio-navy">
          New password <span lang="ta" className="font-medium text-rio-slate">/ புதிய கடவுச்சொல்</span>
        </label>
        <input id="new-password" name="password" type={field} autoComplete="new-password" minLength={12} maxLength={128} aria-describedby="password-help" {...common} className="field mt-2" />
        <p id="password-help" className="mt-1 text-sm text-rio-slate">At least 12 characters.</p>
      </div>
      <div>
        <label htmlFor="confirm-password" className="block font-semibold text-rio-navy">
          Repeat the new password <span lang="ta" className="font-medium text-rio-slate">/ மீண்டும் உள்ளிடவும்</span>
        </label>
        <input id="confirm-password" name="confirm" type={field} autoComplete="new-password" maxLength={128} {...common} className="field mt-2" />
      </div>
      <label className="flex min-h-11 items-center gap-3 font-semibold text-rio-navy">
        <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} className="h-6 w-6 accent-rio-rose" />
        Show the passwords
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
