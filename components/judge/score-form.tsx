"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { saveMyScore } from "@/app/judge/actions";
import { Bilingual, FieldError } from "@/components/auth/bilingual";
import type { Msg } from "@/lib/auth/messages";
import { staff } from "@/lib/staff/messages";

// A judge's own score for one entry: save a draft as often as needed, then submit it as final (after a confirmation). The server
// action and the database decide what is allowed; this screen only shows the state and prevents a double send.

export type ScoreFormProps = { entryId: string; marks: number | null; comments: string | null; status: "draft" | "final" | null };
type State = { kind: "editing" } | { kind: "confirming" } | { kind: "saving" } | { kind: "saved"; final: boolean } | { kind: "failed"; message: Msg };
const E = staff.judge.errors;
const input = "field mt-2";
const button = "btn w-full sm:w-auto";

export function ScoreForm(p: ScoreFormProps) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "editing" });
  const [marks, setMarks] = useState(p.marks === null ? "" : String(p.marks));
  const [comments, setComments] = useState(p.comments ?? "");
  const inflight = useRef(false);

  if (p.status === "final") {
    return (
      <div className="space-y-2 rounded-xl border-2 border-rio-navy/15 bg-white p-4">
        <p className="font-display text-2xl font-bold text-rio-navy">{p.marks}</p>
        {p.comments && <p className="whitespace-pre-wrap text-rio-ink">{p.comments}</p>}
        <p className="text-rio-slate">
          <Bilingual m={staff.judge.finalLocked} />
        </p>
      </div>
    );
  }

  async function save(final: boolean) {
    if (inflight.current) return;
    inflight.current = true;
    setState({ kind: "saving" });
    const result = await saveMyScore({ entryId: p.entryId, marks, comments, final }).catch(() => null);
    inflight.current = false;
    if (!result) return setState({ kind: "failed", message: E.network });
    if (!result.ok) return setState({ kind: "failed", message: E[result.code] ?? E.unavailable });
    setState({ kind: "saved", final: result.status === "final" });
    router.refresh();
  }

  const busy = state.kind === "saving";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (state.kind !== "confirming") void save(false);
      }}
      noValidate
      className="space-y-4"
    >
      <div>
        <label htmlFor="marks" className="block font-semibold text-rio-navy">
          <Bilingual m={staff.judge.marks} />
        </label>
        <input id="marks" name="marks" inputMode="decimal" autoComplete="off" value={marks} onChange={(e) => setMarks(e.target.value)} className={input} aria-describedby={state.kind === "failed" ? "score-error" : undefined} />
      </div>
      <div>
        <label htmlFor="comments" className="block font-semibold text-rio-navy">
          <Bilingual m={staff.judge.comments} />
        </label>
        <textarea id="comments" name="comments" rows={4} maxLength={2000} value={comments} onChange={(e) => setComments(e.target.value)} className={`${input} py-3`} />
      </div>

      {state.kind === "failed" && <FieldError id="score-error" m={state.message} />}
      {state.kind === "saved" && (
        <p role="status" className="font-semibold text-rio-ok">
          <Bilingual m={state.final ? staff.judge.savedFinal : staff.judge.saved} />
        </p>
      )}

      {state.kind === "confirming" ? (
        <div className="space-y-3 rounded-xl border-2 border-rio-navy bg-white p-4">
          <p className="font-semibold text-rio-navy">
            <Bilingual m={staff.judge.finalWarning} />
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <button type="button" onClick={() => void save(true)} className={`${button} btn-primary`}>
              <span>{staff.judge.confirmFinal.ta}</span>
              <span lang="en" className="font-medium">{staff.judge.confirmFinal.en}</span>
            </button>
            <button type="button" onClick={() => setState({ kind: "editing" })} className={`${button} btn-outline`}>
              <span>{staff.judge.cancel.ta}</span>
              <span lang="en" className="font-medium">{staff.judge.cancel.en}</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row">
          <button type="submit" disabled={busy} aria-busy={busy} className={`${button} btn-outline`}>
            <span>{staff.judge.saveDraft.ta}</span>
            <span lang="en" className="font-medium">{staff.judge.saveDraft.en}</span>
          </button>
          <button type="button" disabled={busy} onClick={() => setState({ kind: "confirming" })} className={`${button} btn-primary`}>
            <span>{staff.judge.submitFinal.ta}</span>
            <span lang="en" className="font-medium">{staff.judge.submitFinal.en}</span>
          </button>
        </div>
      )}
    </form>
  );
}
