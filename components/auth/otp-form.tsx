"use client";

import { useActionState, useEffect, useState } from "react";
import { resendCode, verifyCode } from "@/app/signin/actions";
import { secondsLeft } from "@/lib/auth/cooldown";
import { copy } from "@/lib/auth/messages";
import { Bilingual, FieldError } from "./bilingual";
import { SubmitButton } from "./submit-button";

export function OtpForm({ event, sentAt, length }: { event: string | null; sentAt: number; length: number }) {
  const [verifyState, verifyAction] = useActionState(verifyCode, undefined);
  const [resendState, resendAction] = useActionState(resendCode, undefined);
  // null until mounted, so the server HTML and the first client render agree
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setLeft(secondsLeft(sentAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [sentAt]);

  const hasField = Boolean(verifyState?.fieldError);
  const waiting = left === null || left > 0;

  return (
    <div className="space-y-8">
      <form action={verifyAction} noValidate className="space-y-4">
        {event && <input type="hidden" name="event" value={event} />}
        <div>
          <label htmlFor="code" className="block font-semibold text-rio-navy">
            <Bilingual m={copy.verify.codeLabel(length)} />
          </label>
          <input
            id="code"
            name="code"
            type="text"
            inputMode="numeric"
            pattern="[0-9 ]*"
            autoComplete="one-time-code"
            maxLength={length + 2} // room for a space or two when a code is pasted; the server checks the exact length
            enterKeyHint="done"
            required
            autoFocus
            aria-invalid={hasField}
            aria-describedby={hasField ? "code-error" : undefined}
            className="mt-2 min-h-14 w-full rounded-xl border-2 border-rio-navy bg-white px-4 text-center font-display text-2xl font-bold tracking-[0.3em] text-rio-ink sm:max-w-sm sm:text-3xl sm:tracking-[0.4em]"
          />
          {verifyState?.fieldError && <FieldError id="code-error" m={verifyState.fieldError} />}
        </div>
        {verifyState?.error && <FieldError id="verify-error" m={verifyState.error} />}
        <SubmitButton idle={copy.verify.verify} busy={copy.verify.verifying} />
      </form>

      <form action={resendAction} className="space-y-2 border-t border-rio-navy/15 pt-6">
        {event && <input type="hidden" name="event" value={event} />}
        <SubmitButton idle={copy.verify.resend} busy={copy.verify.resending} tone="secondary" disabled={waiting} />
        <p role="status" className="min-h-7 font-semibold text-rio-navy">
          {left !== null && left > 0 && (
            <>
              {copy.verify.resendIn.ta} {left} {copy.verify.seconds.ta}
              <span lang="en" className="block font-medium text-rio-slate">
                {copy.verify.resendIn.en} {left} {copy.verify.seconds.en}
              </span>
            </>
          )}
        </p>
        {resendState?.error && <FieldError id="resend-error" m={resendState.error} />}
      </form>
    </div>
  );
}
