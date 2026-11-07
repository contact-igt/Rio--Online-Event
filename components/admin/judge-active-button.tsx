"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { setJudgeActive } from "@/app/admin/judges/actions";
import { staff } from "@/lib/staff/messages";

// Switch one judge on, or off after an explicit confirmation step. The server enforces the confirmation too; this screen only asks for it
// and prevents a double send.

const M = staff.judges;
type State = { kind: "idle" } | { kind: "confirming" } | { kind: "saving" } | { kind: "failed"; message: string };

export function JudgeActiveButton({ judgeId, name, active }: { judgeId: string; name: string; active: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "idle" });
  const inflight = useRef(false);

  async function run(next: boolean) {
    if (inflight.current) return;
    inflight.current = true;
    setState({ kind: "saving" });
    const result = await setJudgeActive({ judgeId, active: next, confirmed: next ? undefined : true }).catch(() => null);
    inflight.current = false;
    if (!result) return setState({ kind: "failed", message: M.errors.unavailable });
    if (!result.ok) return setState({ kind: "failed", message: result.code === "invalid" ? M.errors.invalidId : M.errors[result.code] });
    setState({ kind: "idle" });
    router.refresh();
  }

  const busy = state.kind === "saving";
  if (state.kind === "confirming" || (busy && active)) {
    return (
      <div role="group" aria-label={`Confirm deactivating ${name}`} className="space-y-2">
        <p className="max-w-xs text-sm font-semibold text-rio-navy">{M.confirmOff}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} aria-busy={busy} onClick={() => void run(false)} className="btn btn-primary min-h-11 !px-4 !py-1 text-sm">
            {M.confirmOffYes.en}
          </button>
          <button type="button" disabled={busy} onClick={() => setState({ kind: "idle" })} className="btn btn-outline min-h-11 !px-4 !py-1 text-sm">
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <div>
      <button
        type="button"
        disabled={busy}
        aria-label={`${active ? M.deactivate.en : M.activate.en} ${name}`}
        onClick={() => (active ? setState({ kind: "confirming" }) : void run(true))}
        className="btn btn-outline min-h-11 !px-4 !py-1 text-sm"
      >
        {active ? M.deactivate.en : M.activate.en}
      </button>
      {state.kind === "failed" && (
        <p role="alert" className="mt-1 max-w-xs text-sm font-semibold text-rio-error">
          {state.message}
        </p>
      )}
    </div>
  );
}
