"use client";

import { useFormStatus } from "react-dom";
import type { Msg } from "../../lib/auth/messages";

const base = "btn w-full disabled:cursor-wait disabled:opacity-75 sm:w-auto";

export function SubmitButton({ idle, busy, tone = "primary", disabled = false }: { idle: Msg; busy: Msg; tone?: "primary" | "secondary"; disabled?: boolean }) {
  const { pending } = useFormStatus();
  const style = tone === "primary" ? "btn-primary" : "btn-outline";
  const label = pending ? busy : idle;
  return (
    <button type="submit" disabled={pending || disabled} aria-busy={pending} className={`${base} ${style}`}>
      <span>{label.ta}</span>
      <span lang="en" className="font-medium">
        {label.en}
      </span>
    </button>
  );
}
