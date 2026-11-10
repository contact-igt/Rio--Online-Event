// Browser entry for e2e/registration-ui.spec.ts: the REAL ProgressSteps, DraftList, SubmittedPanel, RegisterCall and RegistrationForm
// (with its fake save action), shown the way the registration page composes them. Bundled by the spec; never part of the app.
import { createRoot } from "react-dom/client";
import { EventSummary } from "@/components/registration/event-summary";
import { DraftList } from "@/components/registration/draft-list";
import { ProgressSteps, type Stage } from "@/components/registration/progress-steps";
import { RegistrationForm } from "@/components/registration/registration-form";
import { SubmittedPanel } from "@/components/registration/submitted-panel";
import { RegisterCall } from "@/components/register-call";
import { getEvent } from "@/lib/events";
import { getConsentCopy } from "@/lib/registration/consent";
import type { OwnRegistration } from "@/lib/registration/drafts";

const stage = (location.hash.replace("#", "") || "none") as Stage;
const row = (id: string, status: string, name: string): OwnRegistration =>
  ({ id, status, child_name: name, child_age: 9, parent_mobile: "+919876543210", event_id: 4, media_consent: false, parent_name: "P", finalized_at: null }) as unknown as OwnRegistration;
const consent = getConsentCopy("v0-provisional")!;

createRoot(document.getElementById("root")!).render(
  <div className="mx-auto max-w-2xl space-y-8 p-4">
    <EventSummary event={getEvent("kutti-pesalar")!} />
    <ProgressSteps stage={stage} />
    <DraftList slug="kutti-pesalar" currentId={null} canEdit items={[row("a", "draft", "Asha"), row("b", "uploaded", "Bala"), row("c", "finalized", "Chitra")]} />
    <SubmittedPanel childName="Asha" childAge={9} eventNameTa="குட்டிப் பேச்சாளர்" eventNameEn="Little Speaker" submittedAt="2026-11-10T09:30:00Z" mediaConsent={false} registeredEmail="p***@example.org" emailMasked="p***@example.org" reference="RIO-AB12C-DE34F" />
    <SubmittedPanel childName="Asha" childAge={9} eventNameTa="குட்டிப் பேச்சாளர்" eventNameEn="Little Speaker" submittedAt={null} mediaConsent emailMasked={null} reference={null} />
    <RegisterCall slug="kutti-pesalar" open />
    <RegisterCall slug="kutti-pesalar" open={false} />
    <RegistrationForm event={{ slug: "kutti-pesalar", minAge: 8, maxAge: 12 }} email="synthetic@example.test" consent={consent} draft={null} />
  </div>,
);
