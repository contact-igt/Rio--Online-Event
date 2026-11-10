import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RegistrationPreview } from "@/components/dev/registration-preview";
import { EventSummary } from "@/components/registration/event-summary";
import { Icon } from "@/components/ui/icon";
import { getEvent } from "@/lib/events";
import { getConsentCopy } from "@/lib/registration/consent";
import { reg } from "@/lib/registration/messages";
import { parseRegistration, type FieldErrors } from "@/lib/registration/schemas";

export const metadata: Metadata = { title: "Registration preview (development)", robots: { index: false } };
export const dynamic = "force-dynamic";

// DEVELOPMENT ONLY. In a production build (next build / next start, every Vercel deployment) this route is a plain 404 and renders nothing:
// the check is the first line of the page and of the layout. It never opens registration and never talks to Supabase or storage.
export default function RegistrationPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();

  const event = getEvent("kutti-pesalar")!;
  const consent = getConsentCopy("v0-provisional")!;
  // Deliberately bad input, run through the real validator, so the errors shown are the real ones.
  const bad = { event: event.slug, childName: "", childAge: "", parentName: " ", mobile: "12345", consentVersion: consent.version, mediaConsent: "" };
  const parsed = parseRegistration(event, bad, true);
  const fieldErrors: FieldErrors = parsed.ok ? {} : parsed.errors;

  return (
    <section className="mx-auto w-full max-w-[1200px] px-4 py-[clamp(1.5rem,5vw,3rem)] sm:px-6 lg:px-8">
      <p role="note" className="flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 font-semibold text-rio-navy">
        <Icon name="info" className="mt-0.5 h-6 w-6 shrink-0 text-amber-700" />
        <span>Development preview. Nothing here is saved, uploaded or sent, and registration is not opened. This page does not exist in production.</span>
      </p>
      <h1 className="mt-4 text-[clamp(1.75rem,5vw,2.5rem)] font-extrabold">Registration form preview</h1>
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
        <EventSummary event={event} />
        <RegistrationPreview consent={{ version: consent.version, notice: consent.notice, guardian: consent.guardian, media: consent.media }} invalid={{ error: reg.errors.fix, fieldErrors, values: { ...bad, guardianConsent: "" } }} />
      </div>
    </section>
  );
}
