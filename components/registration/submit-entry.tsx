"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { submitEntry } from "@/app/events/[slug]/register/submit-actions";
import { Bilingual, FieldError } from "@/components/auth/bilingual";
import { reg, type Msg } from "@/lib/registration/messages";
import type { FinalizeErrorCode } from "@/lib/submit/service";

// Final submission of one entry, with a confirmation step. The parent sees exactly what will be submitted, is told in plain
// words that it is final, and cannot send the request twice: the confirm button is disabled while the request runs and a
// guard rejects a second click that arrives before the screen has updated. This screen only decides what is shown; the server
// action and the database decide what is allowed.
//
// The optional permission to share the entry (media consent) is shown for information only. It is not a condition of entering.

export type SubmitDetails = { submissionId: string; slug: string; childName: string; childAge: number; eventNameTa: string; eventNameEn: string; mediaConsent: boolean };

type State = { kind: "idle" } | { kind: "confirming" } | { kind: "submitting" } | { kind: "done"; already: boolean } | { kind: "failed"; message: Msg };

const ERRORS = reg.submit.errors;
const messageFor = (code: FinalizeErrorCode): Msg => ERRORS[code as keyof typeof ERRORS] ?? ERRORS.unavailable;

const button = "btn w-full sm:w-auto";

export function SubmitEntry(d: SubmitDetails) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "idle" });
  const inflight = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (state.kind === "confirming") heading.current?.focus(); // keyboard and screen-reader users land on the review
  }, [state.kind]);

  async function confirm() {
    if (inflight.current) return; // a second click before the screen has updated
    inflight.current = true;
    setState({ kind: "submitting" });
    const result = await submitEntry({ submissionId: d.submissionId, slug: d.slug }).catch(() => null);
    if (!result) {
      inflight.current = false;
      return setState({ kind: "failed", message: ERRORS.network });
    }
    if (!result.ok) {
      inflight.current = false;
      return setState({ kind: "failed", message: messageFor(result.code) });
    }
    setState({ kind: "done", already: result.already });
    router.refresh(); // the page now shows the saved, submitted entry
  }

  function back() {
    inflight.current = false;
    setState({ kind: "idle" });
    queueMicrotask(() => opener.current?.focus());
  }

  if (state.kind === "done") {
    return (
      <div role="status" className="rounded-2xl border-2 border-rio-ok bg-white p-4">
        <p className="font-display text-xl font-bold text-rio-ok">
          {reg.submit.doneTitle.ta} <span lang="en" className="font-medium">/ {reg.submit.doneTitle.en}</span>
        </p>
        <p className="mt-1">
          <Bilingual m={state.already ? reg.submit.already : reg.submit.doneBody} />
        </p>
        <p className="mt-2 font-semibold text-rio-navy">
          {reg.submit.status.ta}: {reg.submit.submitted.ta} <span lang="en" className="font-medium">/ {reg.submit.status.en}: {reg.submit.submitted.en}</span>
        </p>
      </div>
    );
  }

  if (state.kind === "idle") {
    return (
      <button ref={opener} type="button" aria-expanded={false} onClick={() => setState({ kind: "confirming" })} className={`${button} btn-primary`}>
        <span>{reg.nextSteps.submit.ta}</span>
        <span lang="en" className="font-medium">{reg.nextSteps.submit.en}</span>
      </button>
    );
  }

  const busy = state.kind === "submitting";
  return (
    <section
      aria-labelledby="submit-review"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) back(); // keyboard: leave the review without submitting
      }}
      className="card-soft space-y-4 p-4 sm:p-5"
    >
      <h3 id="submit-review" ref={heading} tabIndex={-1} className="font-display text-xl font-bold text-rio-navy outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rio-blue">
        {reg.submit.review.ta} <span lang="en" className="font-medium text-rio-slate">/ {reg.submit.review.en}</span>
      </h3>

      <dl className="space-y-3">
        <div>
          <dt className="text-rio-slate">
            <Bilingual m={reg.submit.competition} />
          </dt>
          <dd className="font-semibold text-rio-navy">
            {d.eventNameTa} <span lang="en" className="font-medium text-rio-slate">/ {d.eventNameEn}</span>
          </dd>
        </div>
        <div>
          <dt className="text-rio-slate">
            <Bilingual m={reg.submit.child} />
          </dt>
          <dd className="font-semibold text-rio-navy">
            {d.childName} · {reg.submit.age.ta} {d.childAge} <span lang="en" className="font-medium text-rio-slate">/ {reg.submit.age.en} {d.childAge}</span>
          </dd>
        </div>
      </dl>

      <p className="rounded-xl border-l-4 border-rio-pink bg-rio-blush p-3 font-semibold text-rio-navy">
        <Bilingual m={reg.submit.final} />
      </p>
      <p className="text-rio-slate">
        <Bilingual m={d.mediaConsent ? reg.submit.mediaGiven : reg.submit.mediaNotGiven} />
      </p>

      {state.kind === "failed" && <FieldError id="submit-error" m={state.message} />}

      <div className="flex flex-col gap-3 sm:flex-row">
        <button type="button" onClick={() => void confirm()} disabled={busy} aria-busy={busy} className={`${button} btn-primary`}>
          <span>{(busy ? reg.submit.submitting : state.kind === "failed" ? reg.submit.retry : reg.submit.confirm).ta}</span>
          <span lang="en" className="font-medium">{(busy ? reg.submit.submitting : state.kind === "failed" ? reg.submit.retry : reg.submit.confirm).en}</span>
        </button>
        <button type="button" onClick={back} disabled={busy} className={`${button} btn-outline`}>
          <span>{reg.submit.back.ta}</span>
          <span lang="en" className="font-medium">{reg.submit.back.en}</span>
        </button>
      </div>
    </section>
  );
}
