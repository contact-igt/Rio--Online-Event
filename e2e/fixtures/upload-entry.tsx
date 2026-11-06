// Browser entry for e2e/upload-panel.spec.ts: the REAL NextSteps (which renders the REAL UploadPanel) with fake server actions.
import { createRoot } from "react-dom/client";
import { NextSteps } from "@/components/registration/next-steps";

const mode = location.hash;
const upload =
  mode === "#off"
    ? ({ kind: "off" } as const)
    : ({ kind: "on", submissionId: "bbbbbbbb-0000-4000-8000-0000000000b1", hasVideo: mode === "#has" } as const);

createRoot(document.getElementById("root")!).render(<NextSteps upload={upload} submit={{ kind: "off" }} />);
