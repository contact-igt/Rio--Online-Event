"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { assignJudge } from "@/app/admin/actions";
import { Bilingual, FieldError } from "@/components/auth/bilingual";
import type { Msg } from "@/lib/auth/messages";
import { staff } from "@/lib/staff/messages";

// Assign one judge to every submitted entry of this competition. Safe to repeat: only entries not yet assigned are added.
type State = { kind: "idle" } | { kind: "saving" } | { kind: "done"; added: number } | { kind: "failed"; message: Msg };
const E = staff.admin.assignErrors;

export function AssignJudgeForm({ slug, judges }: { slug: string; judges: { id: string; name: string }[] }) {
  const router = useRouter();
  const [judgeId, setJudgeId] = useState(judges[0]?.id ?? "");
  const [state, setState] = useState<State>({ kind: "idle" });
  const inflight = useRef(false);

  async function submit() {
    if (inflight.current || !judgeId) return;
    inflight.current = true;
    setState({ kind: "saving" });
    const result = await assignJudge({ slug, judgeId }).catch(() => null);
    inflight.current = false;
    if (!result) return setState({ kind: "failed", message: E.network });
    if (!result.ok) return setState({ kind: "failed", message: E[result.code] ?? E.unavailable });
    setState({ kind: "done", added: result.added });
    router.refresh();
  }

  if (!judges.length) return <p className="text-rio-slate">No active judges exist yet. Add judges in the database first.</p>;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="space-y-3"
    >
      <p className="text-rio-slate">
        <Bilingual m={staff.admin.assignHelp} />
      </p>
      <label htmlFor="judge" className="block font-semibold text-rio-navy">Judge</label>
      <select id="judge" value={judgeId} onChange={(e) => setJudgeId(e.target.value)} className="field sm:w-80">
        {judges.map((j) => (
          <option key={j.id} value={j.id}>{j.name}</option>
        ))}
      </select>
      {state.kind === "failed" && <FieldError id="assign-error" m={state.message} />}
      {state.kind === "done" && (
        <p role="status" className="font-semibold text-rio-ok">
          {state.added} entries added.
        </p>
      )}
      <button type="submit" disabled={state.kind === "saving"} aria-busy={state.kind === "saving"} className="btn btn-primary w-full sm:w-auto">
        <span>{staff.admin.assign.ta}</span>
        <span lang="en" className="font-medium">{staff.admin.assign.en}</span>
      </button>
    </form>
  );
}
