"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { confirmWinnerAction, removeWinnerAction } from "@/app/admin/actions";
import { Bilingual, FieldError } from "@/components/auth/bilingual";
import type { Msg } from "@/lib/auth/messages";
import { staff } from "@/lib/staff/messages";

// Winner controls for one ranked entry. Confirming never publishes anything; the display name is typed here, never copied.
const E = staff.admin.winnerErrors;
const field = "field mt-1 !min-h-11";

export function ConfirmWinnerForm({ slug, submissionId, tie, suggestedRank, noSharePermission }: { slug: string; submissionId: string; tie: boolean; suggestedRank: number; noSharePermission: boolean }) {
  const router = useRouter();
  const [rank, setRank] = useState(String(Math.min(suggestedRank, 10)));
  const [displayName, setDisplayName] = useState("");
  const [awardLabel, setAwardLabel] = useState("");
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<Msg | null>(null);
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);

  async function submit() {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    const result = await confirmWinnerAction({ slug, submissionId, rank, displayName, awardLabel, acknowledgeTie: ack }).catch(() => null);
    inflight.current = false;
    setBusy(false);
    if (!result) return setError(E.network);
    if (!result.ok) return setError(E[result.code] ?? E.unavailable);
    router.refresh();
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="grid gap-3 sm:grid-cols-[6rem_1fr_1fr]"
    >
      <label className="block text-sm font-semibold text-rio-navy">
        Rank
        <select value={rank} onChange={(e) => setRank(e.target.value)} className={field}>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
      <label className="block text-sm font-semibold text-rio-navy">
        Display name (typed by you)
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={60} required className={field} autoComplete="off" />
      </label>
      <label className="block text-sm font-semibold text-rio-navy">
        Award label (optional)
        <input value={awardLabel} onChange={(e) => setAwardLabel(e.target.value)} maxLength={80} className={field} autoComplete="off" />
      </label>
      {noSharePermission && (
        <p className="rounded-xl border-l-4 border-rio-pink bg-rio-blush p-3 text-sm font-semibold text-rio-navy sm:col-span-3">
          The parent did not give the optional permission to share the child&apos;s first name. The display name is shown to the public once results are published: do not type the child&apos;s name for this entry (use a neutral label) unless the hospital has decided otherwise.
        </p>
      )}
      {tie && (
        <label className="flex items-start gap-2 text-sm font-semibold text-rio-navy sm:col-span-3">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1 size-5" />
          This entry is tied with another. No tie rule is approved; I am deciding this myself.
        </label>
      )}
      {error && (
        <div className="sm:col-span-3">
          <FieldError id={`winner-error-${submissionId}`} m={error} />
        </div>
      )}
      <div className="sm:col-span-3">
        <button type="submit" disabled={busy} aria-busy={busy} className="btn btn-primary">
          <span>{staff.admin.confirmWinner.ta}</span>
          <span lang="en" className="font-medium">{staff.admin.confirmWinner.en}</span>
        </button>
      </div>
    </form>
  );
}

export function RemoveWinnerButton({ winnerId }: { winnerId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Msg | null>(null);
  const inflight = useRef(false);
  async function remove() {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    const result = await removeWinnerAction({ winnerId }).catch(() => null);
    inflight.current = false;
    setBusy(false);
    if (!result) return setError(E.network);
    if (!result.ok) return setError(E[result.code] ?? E.unavailable);
    router.refresh();
  }
  return (
    <>
      <button type="button" onClick={() => void remove()} disabled={busy} className="btn btn-outline min-h-11 !py-1">
        <Bilingual m={staff.admin.remove} />
      </button>
      {error && <FieldError id={`remove-error-${winnerId}`} m={error} />}
    </>
  );
}
