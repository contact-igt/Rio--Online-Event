"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { staff } from "@/lib/staff/messages";

// Shows a freshly generated password to the administrator ONCE. It lives only in this component's state: it is not written to storage, a URL or
// a form field (so a browser or password manager does not offer to save it), and it disappears when the administrator hides it, after five minutes,
// or when the page is left.

const M = staff.judges.credentials;
const SHOWN_FOR_MS = 5 * 60_000;

export function CredentialsPanel({ email, password, onDone }: { email: string | null; password: string; onDone: () => void }) {
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(onDone, SHOWN_FOR_MS);
    return () => clearTimeout(t);
  }, [onDone]);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNote(M.copied);
    } catch {
      setNote(M.copyFailed);
    }
  }

  const details = `${email ? `Email: ${email}\n` : ""}Password: ${password}\nSign in at: ${window.location.origin}/staff/login`;

  return (
    <div role="group" aria-label={M.title.en} className="space-y-3 rounded-2xl border border-rio-navy/20 bg-rio-mist p-4">
      <p className="flex items-center gap-2 font-display text-lg font-bold text-rio-navy">
        <Icon name="lock" className="h-5 w-5 text-rio-rose" />
        {M.title.en} <span lang="ta" className="font-semibold text-rio-slate">/ {M.title.ta}</span>
      </p>
      {email && (
        <p className="text-sm text-rio-navy">
          <span className="font-semibold">Email:</span> <span className="break-all">{email}</span>
        </p>
      )}
      <div>
        <p className="text-sm font-semibold text-rio-navy">{M.password}</p>
        <code translate="no" className="mt-1 block select-all break-all rounded-xl bg-white px-3 py-2 font-mono text-lg font-bold tracking-wide text-rio-navy">
          {password}
        </code>
      </div>
      <p className="text-sm font-semibold text-rio-navy">{M.once}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void copy(password)} className="btn btn-outline min-h-11 !px-4 !py-1 text-sm">
          {M.copyPassword}
        </button>
        <button type="button" onClick={() => void copy(details)} className="btn btn-outline min-h-11 !px-4 !py-1 text-sm">
          {M.copyAll}
        </button>
        <button type="button" onClick={onDone} className="btn btn-primary min-h-11 !px-4 !py-1 text-sm">
          {M.done}
        </button>
      </div>
      <p role="status" className="min-h-5 text-sm font-semibold text-rio-navy">
        {note}
      </p>
    </div>
  );
}

export function HiddenNote() {
  return <p className="text-sm text-rio-slate">{M.hidden}</p>;
}
