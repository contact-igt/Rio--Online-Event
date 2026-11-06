"use client";

import { useActionState } from "react";
import { saveDraft } from "@/app/events/[slug]/register/actions";
import { Bilingual, FieldError } from "@/components/auth/bilingual";
import { SubmitButton } from "@/components/auth/submit-button";
import { Icon, type IconName } from "@/components/ui/icon";
import { reg, type Msg } from "@/lib/registration/messages";
import type { Field } from "@/lib/registration/schemas";

export type FormDraft = {
  id: string;
  childName: string;
  childAge: number;
  parentName: string;
  mobileLocal: string; // the 10 digits, without +91
  mediaConsent: boolean;
};

type Props = {
  event: { slug: string; minAge: number; maxAge: number };
  email: string;
  consent: { version: string; notice: Msg; guardian: Msg; media: Msg };
  draft: FormDraft | null;
};

const check = "mt-1 h-6 w-6 shrink-0 accent-rio-rose";
const tag = "ml-2 inline-block rounded-full bg-rio-blush px-2 py-0.5 align-middle text-xs font-bold text-rio-rose";

function SectionBar({ icon, m, tone = "mist" }: { icon: IconName; m: Msg; tone?: "mist" | "blush" }) {
  return (
    <h3 className={`flex items-center gap-3 rounded-xl px-4 py-2.5 font-display text-lg font-bold ${tone === "mist" ? "bg-rio-mist" : "bg-rio-blush"}`}>
      <Icon name={icon} className="h-6 w-6 text-rio-rose" />
      <span>
        {m.ta} <span lang="en">/ {m.en}</span>
      </span>
    </h3>
  );
}

export function RegistrationForm({ event, email, consent, draft }: Props) {
  const [state, action] = useActionState(saveDraft, undefined);
  const v = state?.values;
  // React resets a form after every action. A text input's defaultValue follows the values the action returned, but a
  // <select>'s does not, so the age fell back to "Choose" after any error while the other fields kept theirs. Keying the
  // select by the returned age remounts it with that age as its default, which is what the reset then restores. (A
  // controlled select is not enough: the reset changes the DOM and React sees no state change to re-apply.)
  const initialAge = draft ? String(draft.childAge) : "";
  const age = v?.childAge ?? initialAge;
  const editing = draft !== null;
  const err = (f: Field) => state?.fieldErrors?.[f];
  const ages = Array.from({ length: event.maxAge - event.minAge + 1 }, (_, i) => event.minAge + i);
  const aria = (f: Field) => ({ "aria-invalid": Boolean(err(f)), "aria-describedby": err(f) ? `${f}-error` : undefined });
  const required = (
    <span className={tag}>
      {reg.form.required.en} / {reg.form.required.ta}
    </span>
  );

  return (
    <form action={action} noValidate className="space-y-5">
      <p className="rounded-xl bg-rio-mist px-4 py-3 font-semibold text-rio-navy">
        <Bilingual m={reg.form.requiredNote} />
      </p>
      <input type="hidden" name="event" value={event.slug} />
      <input type="hidden" name="consentVersion" value={consent.version} />
      {draft && <input type="hidden" name="draftId" value={draft.id} />}

      <SectionBar icon="smile" m={reg.form.childSection} />
      <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_14rem]">
        <div>
          <label htmlFor="childName" className="block font-semibold text-rio-navy">
            <Bilingual m={reg.form.childName} />
            {required}
          </label>
          <input id="childName" name="childName" type="text" autoComplete="off" required maxLength={80} defaultValue={v?.childName ?? draft?.childName ?? ""} className="field mt-2" {...aria("childName")} />
          {err("childName") && <FieldError id="childName-error" m={err("childName")!} />}
        </div>

        <div>
          <label htmlFor="childAge" className="block font-semibold text-rio-navy">
            <Bilingual m={reg.form.childAge} />
            {required}
          </label>
          <select key={age} id="childAge" name="childAge" required defaultValue={age} className="field mt-2" {...aria("childAge")}>
            <option value="" disabled>
              {reg.form.agePlaceholder.ta} / {reg.form.agePlaceholder.en}
            </option>
            {ages.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <p className="mt-2 text-sm text-rio-slate">
            <Bilingual m={reg.form.ageHelp(event.minAge, event.maxAge)} />
          </p>
          {err("childAge") && <FieldError id="childAge-error" m={err("childAge")!} />}
        </div>
      </div>

      <SectionBar icon="users" m={reg.form.parentSection} />
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="parentName" className="block font-semibold text-rio-navy">
            <Bilingual m={reg.form.parentName} />
            {required}
          </label>
          <input id="parentName" name="parentName" type="text" autoComplete="name" required maxLength={80} defaultValue={v?.parentName ?? draft?.parentName ?? ""} className="field mt-2" {...aria("parentName")} />
          {err("parentName") && <FieldError id="parentName-error" m={err("parentName")!} />}
        </div>

        <div>
          <p className="font-semibold text-rio-navy">
            <Bilingual m={reg.form.email} />
          </p>
          <p className="field field-static mt-2 flex items-center gap-2 [overflow-wrap:anywhere]">
            <Icon name="lock" className="h-5 w-5 text-rio-slate" />
            {email}
          </p>
          <p className="mt-2 text-sm text-rio-slate">
            <Bilingual m={reg.form.emailHelp} />
          </p>
        </div>

        <div>
          <label htmlFor="mobile" className="block font-semibold text-rio-navy">
            <Bilingual m={reg.form.mobile} />
            {required}
          </label>
          <div className="mt-2 flex items-stretch gap-2">
            <span aria-hidden="true" className="field field-static grid !w-auto place-items-center font-semibold text-rio-navy">
              +91
            </span>
            <input id="mobile" name="mobile" type="tel" inputMode="numeric" autoComplete="tel-national" required maxLength={16} defaultValue={v?.mobile ?? draft?.mobileLocal ?? ""} className="field min-w-0" {...aria("mobile")} />
          </div>
          <p className="mt-2 text-sm text-rio-slate">
            <Bilingual m={reg.form.mobileHelp} />
          </p>
          {err("mobile") && <FieldError id="mobile-error" m={err("mobile")!} />}
        </div>
      </div>

      <fieldset className="space-y-4">
        <legend className="w-full">
          <SectionBar icon="check" m={reg.form.consentTitle} tone="blush" />
        </legend>
        <p className="rounded-xl border-l-4 border-rio-pink bg-rio-blush p-3 font-semibold text-rio-navy">
          <Bilingual m={consent.notice} />
        </p>

        {editing ? (
          <p className="font-semibold text-rio-ok">
            <Bilingual m={reg.form.consentGiven} />
          </p>
        ) : (
          <div>
            <label className="flex cursor-pointer items-start gap-3">
              <input type="checkbox" name="guardianConsent" defaultChecked={v?.guardianConsent === "on"} required className={check} {...aria("guardianConsent")} />
              <span>
                <strong className="text-rio-rose">
                  {reg.form.required.ta} <span lang="en" className="font-semibold">/ {reg.form.required.en}</span>
                </strong>
                <span className="mt-1 block">{consent.guardian.ta}</span>
                <span lang="en" className="block text-rio-slate">{consent.guardian.en}</span>
              </span>
            </label>
            {err("guardianConsent") && <FieldError id="guardianConsent-error" m={err("guardianConsent")!} />}
          </div>
        )}

        <label className="flex cursor-pointer items-start gap-3 border-t border-rio-navy/15 pt-4">
          <input type="checkbox" name="mediaConsent" defaultChecked={v ? v.mediaConsent === "on" : (draft?.mediaConsent ?? false)} className={check} />
          <span>
            <strong className="text-rio-navy">
              {reg.form.optional.ta} <span lang="en" className="font-semibold text-rio-slate">/ {reg.form.optional.en}</span>
            </strong>
            <span className="mt-1 block">{consent.media.ta}</span>
            <span lang="en" className="block text-rio-slate">{consent.media.en}</span>
          </span>
        </label>
      </fieldset>

      <p className="flex items-start gap-3 rounded-xl bg-rio-mist px-4 py-3 text-sm">
        <Icon name="info" className="mt-0.5 h-5 w-5 text-rio-navy" />
        <Bilingual m={reg.form.afterSave} />
      </p>

      {state?.error && <FieldError id="form-error" m={state.error} />}
      <div className="flex flex-col gap-3 sm:flex-row sm:*:flex-1">
        <SubmitButton idle={editing ? reg.form.saveChanges : reg.form.save} busy={reg.form.saving} />
        {editing && (
          <a href="#next-steps" className="btn btn-outline w-full sm:w-auto">
            <span>{reg.form.toUpload.ta}</span>
            <span lang="en" className="font-medium">{reg.form.toUpload.en}</span>
            <Icon name="arrow" className="h-4 w-4" />
          </a>
        )}
      </div>
    </form>
  );
}
