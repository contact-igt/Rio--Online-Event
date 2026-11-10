// Browser entry for e2e/registration-form.spec.ts: renders the REAL RegistrationForm, with the server action replaced by
// fake-save-draft.ts. Bundled by the spec; never part of the app.

import { createRoot } from "react-dom/client";
import { RegistrationForm } from "@/components/registration/registration-form";
import { getConsentCopy } from "@/lib/registration/consent";

const consent = getConsentCopy("v0-provisional")!;
const editing = location.hash === "#edit";

createRoot(document.getElementById("root")!).render(
  <RegistrationForm
    event={{ slug: "kutti-pesalar", minAge: 8, maxAge: 12 }}
    email="synthetic@example.test"
    consent={consent}
    draft={editing ? { id: "00000000-0000-4000-8000-000000000001", childName: "Asha Draft", childAge: 10, parentName: "Parent Draft", mobileLocal: "9876543210", mediaConsent: true } : null}
  />,
);
