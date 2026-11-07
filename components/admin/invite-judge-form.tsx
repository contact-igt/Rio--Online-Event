"use client";

import { useState } from "react";
import { inviteJudge } from "@/app/admin/judges/actions";
import { Icon } from "@/components/ui/icon";
import { staff } from "@/lib/staff/messages";

// The invitation form. While invitations are switched off the form is disabled and says why; it never pretends an e-mail was sent. A
// success message appears only when the server reports that Supabase Auth accepted the invitation.

const M = staff.judges;
type State = { kind: "idle" } | { kind: "sending" } | { kind: "done"; email: string } | { kind: "failed"; message: string };

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 font-semibold text-rio-navy">
      <Icon name="info" className="mt-0.5 h-6 w-6 shrink-0 text-amber-700" />
      <span>{children}</span>
    </p>
  );
}

export function InviteJudgeForm({ enabled, secretKey }: { enabled: boolean; secretKey: "ok" | "missing" | "badFormat" }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const ready = enabled && secretKey === "ok";
  const busy = state.kind === "sending";

  async function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    const email = String(data.get("email") ?? "");
    setState({ kind: "sending" });
    const result = await inviteJudge({ email, displayName: String(data.get("displayName") ?? "") }).catch(() => null);
    if (!result) return setState({ kind: "failed", message: M.errors.unavailable });
    if (!result.ok) return setState({ kind: "failed", message: M.errors[result.code] });
    form.reset();
    setState({ kind: "done", email });
  }

  return (
    <div className="space-y-4">
      {!enabled && <Warning>{M.off}</Warning>}
      {enabled && secretKey !== "ok" && <Warning>{M.noKey}</Warning>}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy) void submit(e.currentTarget);
        }}
        className="grid gap-4 sm:grid-cols-2"
      >
        <div>
          <label htmlFor="judge-name" className="block font-semibold text-rio-navy">
            {M.name.en} <span lang="ta" className="font-medium text-rio-slate">/ {M.name.ta}</span>
          </label>
          <input id="judge-name" name="displayName" type="text" autoComplete="off" maxLength={80} required disabled={!ready} className="field mt-2" />
        </div>
        <div>
          <label htmlFor="judge-email" className="block font-semibold text-rio-navy">
            {M.email.en} <span lang="ta" className="font-medium text-rio-slate">/ {M.email.ta}</span>
          </label>
          <input id="judge-email" name="email" type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={254} required disabled={!ready} className="field mt-2" />
        </div>
        <div className="sm:col-span-2">
          <button type="submit" disabled={!ready || busy} aria-busy={busy} className="btn btn-primary w-full sm:w-auto">
            <span>{(busy ? M.sending : M.send).en}</span>
            <span lang="ta" className="font-medium">{(busy ? M.sending : M.send).ta}</span>
          </button>
        </div>
      </form>
      {state.kind === "failed" && (
        <p role="alert" className="font-semibold text-rio-error">
          {state.message}
        </p>
      )}
      {state.kind === "done" && (
        <p role="status" className="font-semibold text-rio-ok">
          {M.sent.en} for <span className="break-all">{state.email}</span>. <span className="font-medium text-rio-slate">{M.sentNote}</span>
        </p>
      )}
    </div>
  );
}
