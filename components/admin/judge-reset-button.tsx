"use client";

import { useRef, useState } from "react";
import { resetJudgePassword } from "@/app/admin/judges/actions";
import { CredentialsPanel } from "@/components/admin/credentials-panel";
import { staff } from "@/lib/staff/messages";

// Reset one judge's password. The administrator never sees the old password: the server sets a new generated one, shown once here. The server
// enforces the switch and the role; this screen asks for confirmation and prevents a double send.

const M = staff.judges;
type State =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "saving" }
  | { kind: "done"; password: string }
  | { kind: "failed"; message: string };

export function JudgeResetButton({ judgeId, name, email, ready }: { judgeId: string; name: string; email: string | null; ready: boolean }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const inflight = useRef(false);

  async function run() {
    if (inflight.current) return;
    inflight.current = true;
    setState({ kind: "saving" });
    const result = await resetJudgePassword({ judgeId }).catch(() => null);
    inflight.current = false;
    if (!result) return setState({ kind: "failed", message: M.errors.unavailable });
    if (!result.ok) return setState({ kind: "failed", message: M.resetErrors[result.code] });
    setState({ kind: "done", password: result.password });
  }

  const busy = state.kind === "saving";
  if (state.kind === "done") return <CredentialsPanel email={email} password={state.password} onDone={() => setState({ kind: "idle" })} />;
  if (state.kind === "confirming" || busy) {
    return (
      <div role="group" aria-label={`Confirm resetting the password of ${name}`} className="space-y-2">
        <p className="max-w-xs text-sm font-semibold text-rio-navy">{M.confirmReset}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} aria-busy={busy} onClick={() => void run()} className="btn btn-primary min-h-11 !px-4 !py-1 text-sm">
            {(busy ? M.resetting : M.confirmResetYes).en}
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
        disabled={!ready}
        aria-label={`${M.reset.en} ${name}`}
        onClick={() => setState({ kind: "confirming" })}
        className="btn btn-outline min-h-11 !px-4 !py-1 text-sm"
      >
        {M.reset.en}
      </button>
      {!ready && <p className="mt-1 max-w-xs text-sm text-rio-slate">{M.resetOff}</p>}
      {state.kind === "failed" && (
        <p role="alert" className="mt-1 max-w-xs text-sm font-semibold text-rio-error">
          {state.message}
        </p>
      )}
    </div>
  );
}
