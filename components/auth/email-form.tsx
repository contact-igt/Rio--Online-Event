"use client";

import { useActionState } from "react";
import { requestCode } from "@/app/signin/actions";
import { copy } from "@/lib/auth/messages";
import { Bilingual, FieldError } from "./bilingual";
import { SubmitButton } from "./submit-button";

export function EmailForm({ event }: { event: string | null }) {
  const [state, action] = useActionState(requestCode, undefined);
  const hasField = Boolean(state?.fieldError);

  return (
    <form action={action} noValidate className="space-y-4">
      {event && <input type="hidden" name="event" value={event} />}
      <div>
        <label htmlFor="email" className="block font-semibold text-rio-navy">
          <Bilingual m={copy.signIn.emailLabel} />
        </label>
        <input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="send"
          required
          defaultValue={state?.email ?? ""}
          aria-invalid={hasField}
          aria-describedby={hasField ? "email-error" : undefined}
          className="mt-2 min-h-12 w-full rounded-xl border-2 border-rio-navy bg-white px-4 text-lg text-rio-ink"
        />
        {state?.fieldError && <FieldError id="email-error" m={state.fieldError} />}
      </div>
      {state?.error && <FieldError id="form-error" m={state.error} />}
      <SubmitButton idle={copy.signIn.send} busy={copy.signIn.sending} />
    </form>
  );
}
