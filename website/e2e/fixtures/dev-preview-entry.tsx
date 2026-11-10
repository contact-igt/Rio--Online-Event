// Browser entry for e2e/dev-preview.spec.ts: the REAL RegistrationPreview component (and the real form inside it), composed the way
// app/dev/registration-preview/page.tsx composes it. The page itself cannot be bundled because it is a 404 whenever NODE_ENV is "production",
// which is exactly what the bundler defines. Never part of the app.
import { createRoot } from "react-dom/client";
import { RegistrationPreview } from "@/components/dev/registration-preview";
import { EventSummary } from "@/components/registration/event-summary";
import { getEvent } from "@/lib/events";
import { getConsentCopy } from "@/lib/registration/consent";
import { reg } from "@/lib/registration/messages";
import { parseRegistration, type FieldErrors } from "@/lib/registration/schemas";

const event = getEvent("kutti-pesalar")!;
const consent = getConsentCopy("v0-provisional")!;
const bad = { event: event.slug, childName: "", childAge: "", parentName: " ", mobile: "12345", consentVersion: consent.version, mediaConsent: "" };
const parsed = parseRegistration(event, bad, true);
const fieldErrors: FieldErrors = parsed.ok ? {} : parsed.errors;

createRoot(document.getElementById("root")!).render(
  <div className="mx-auto grid max-w-[1200px] gap-6 p-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
    <EventSummary event={event} />
    <RegistrationPreview consent={{ version: consent.version, notice: consent.notice, guardian: consent.guardian, media: consent.media }} invalid={{ error: reg.errors.fix, fieldErrors, values: { ...bad, guardianConsent: "" } }} />
  </div>,
);
document.body.dataset.ready = "1";
