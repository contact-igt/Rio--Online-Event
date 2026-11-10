"use client";

import { RegistrationForm } from "@/components/registration/registration-form";
import type { SaveState } from "@/app/events/[slug]/register/actions";
import { getEvent } from "@/lib/events";
import { reg, type Msg } from "@/lib/registration/messages";
import { parseRegistration, pickFields } from "@/lib/registration/schemas";

// DEVELOPMENT ONLY (the page that renders this is a 404 in production). The real registration form with a stand-in for its server action:
// it runs the REAL validation so errors are realistic, and then does nothing. No Supabase call, no storage call, nothing is saved or sent.

const event = getEvent("kutti-pesalar")!;

const nothingSaved: Msg = { ta: "முன்னோட்டம்: எதுவும் சேமிக்கப்படவோ அனுப்பப்படவோ இல்லை.", en: "Preview only: nothing was saved or sent." };

async function previewAction(_prev: SaveState, formData: FormData): Promise<SaveState> {
  const raw = pickFields(formData);
  const parsed = parseRegistration(event, raw, !raw.draftId);
  if (!parsed.ok) return { error: reg.errors.fix, fieldErrors: parsed.errors, values: raw };
  return { error: nothingSaved, values: raw };
}

type Props = {
  consent: { version: string; notice: Msg; guardian: Msg; media: Msg };
  /** Built on the server from the real validator, from deliberately bad input. */
  invalid: SaveState;
};

export function RegistrationPreview({ consent, invalid }: Props) {
  const shared = { event: { slug: event.slug, minAge: event.minAge, maxAge: event.maxAge }, email: "parent.preview@example.invalid", consent, action: previewAction };
  return (
    <div className="space-y-10">
      <section aria-labelledby="empty" className="card p-5 sm:p-7">
        <h2 id="empty" className="text-2xl font-bold">1. Empty form <span className="text-rio-slate">· submit it empty to see the real validation</span></h2>
        <div className="mt-5">
          <RegistrationForm {...shared} draft={null} />
        </div>
      </section>

      <section aria-labelledby="invalid" className="card p-5 sm:p-7">
        <h2 id="invalid" className="text-2xl font-bold">2. Validation errors <span className="text-rio-slate">· as the form shows them after a refused save</span></h2>
        <div className="mt-5">
          <RegistrationForm {...shared} draft={null} initialState={invalid} />
        </div>
      </section>

      <section aria-labelledby="draft" className="card p-5 sm:p-7">
        <h2 id="draft" className="text-2xl font-bold">3. Editing a saved draft <span className="text-rio-slate">· consent already recorded</span></h2>
        <div className="mt-5">
          <RegistrationForm {...shared} draft={{ id: "00000000-0000-4000-8000-000000000000", childName: "Sample Child", childAge: 9, parentName: "Sample Parent", mobileLocal: "9876543210", mediaConsent: false }} />
        </div>
      </section>
    </div>
  );
}
