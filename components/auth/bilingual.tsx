import type { Msg } from "@/lib/auth/messages";

/** Tamil first, English second, on two lines. */
export function Bilingual({ m, className = "" }: { m: Msg; className?: string }) {
  return (
    <span className={className}>
      {m.ta}
      <span lang="en" className="block font-medium text-rio-slate">
        {m.en}
      </span>
    </span>
  );
}

/** An error shown in text (not colour alone), announced to screen readers. */
export function FieldError({ id, m }: { id: string; m: Msg }) {
  return (
    <p id={id} role="alert" className="mt-2 font-semibold text-rio-error">
      {m.ta}
      <span lang="en" className="block font-medium">
        {m.en}
      </span>
    </p>
  );
}
