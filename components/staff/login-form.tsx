"use client";

import { useActionState, useState } from "react";
import { staffSignIn } from "@/app/staff/login/actions";
import { staff } from "@/lib/staff/messages";

// English first, concise Tamil second (staff screens). The form posts to the server action; the password is never kept in a URL or
// shown again after a failed attempt (only the email is put back), and the show/hide button only changes this field's type.

const L = staff.login;
const input = "field mt-2";

function Label({ m }: { m: { en: string; ta: string } }) {
  return (
    <>
      {m.en} <span lang="ta" className="font-medium text-rio-slate">/ {m.ta}</span>
    </>
  );
}

export function StaffLoginForm() {
  const [state, action, pending] = useActionState(staffSignIn, undefined);
  const [visible, setVisible] = useState(false);
  const error = state?.error ? L.errors[state.error] : null;

  return (
    <form action={action} noValidate className="space-y-5">
      <div>
        <label htmlFor="staff-email" className="block font-semibold text-rio-navy">
          <Label m={L.email} />
        </label>
        <input
          id="staff-email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          defaultValue={state?.email ?? ""}
          aria-invalid={error !== null}
          aria-describedby={error ? "staff-error" : undefined}
          className={input}
        />
      </div>
      <div>
        <label htmlFor="staff-password" className="block font-semibold text-rio-navy">
          <Label m={L.password} />
        </label>
        <div className="mt-2 flex items-stretch gap-2">
          <input
            id="staff-password"
            name="password"
            type={visible ? "text" : "password"}
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            maxLength={256}
            aria-invalid={error !== null}
            aria-describedby={error ? "staff-error" : undefined}
            className="field min-w-0"
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-pressed={visible}
            aria-controls="staff-password"
            className="btn btn-outline shrink-0 !px-4"
          >
            {(visible ? L.hide : L.show).en}
            <span lang="ta" className="sr-only"> {(visible ? L.hide : L.show).ta}</span>
          </button>
        </div>
      </div>
      {error && (
        <p id="staff-error" role="alert" className="font-semibold text-rio-error">
          {error.en}
          <span lang="ta" className="block font-medium">{error.ta}</span>
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className="btn btn-primary w-full sm:w-auto"
      >
        <span>{(pending ? L.busy : L.submit).en}</span>
        <span lang="ta" className="font-medium">{(pending ? L.busy : L.submit).ta}</span>
      </button>
    </form>
  );
}
