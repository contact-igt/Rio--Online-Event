// Browser entry for e2e/submit-entry.spec.ts: the REAL NextSteps (which renders the REAL SubmitEntry) with a fake server action.
import { createRoot } from "react-dom/client";
import { NextSteps } from "@/components/registration/next-steps";

const mode = location.hash;
const submit =
  mode === "#off"
    ? ({ kind: "off" } as const)
    : ({
        kind: "on",
        submissionId: "bbbbbbbb-0000-4000-8000-0000000000b1",
        slug: "kutti-pesalar",
        childName: "Asha",
        childAge: 9,
        eventNameTa: "குட்டிப் பேச்சாளர்",
        eventNameEn: "Little Speaker",
        mediaConsent: mode === "#media",
      } as const);

createRoot(document.getElementById("root")!).render(<NextSteps upload={{ kind: "off" }} submit={submit} />);
