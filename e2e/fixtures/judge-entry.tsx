// Browser entry for e2e/judge-ui.spec.ts: the REAL PlaybackPanel and ScoreForm with fake server actions.
import { createRoot } from "react-dom/client";
import { PlaybackPanel } from "@/components/judge/playback-panel";
import { ScoreForm } from "@/components/judge/score-form";

const mode = location.hash;
const ENTRY = "bbbbbbbb-0000-4000-8000-0000000000b1";

createRoot(document.getElementById("root")!).render(
  <div className="space-y-8">
    <PlaybackPanel entryId={ENTRY} available={mode !== "#off"} />
    <ScoreForm entryId={ENTRY} marks={mode === "#final" ? 88.5 : mode === "#draft" ? 70 : null} comments={mode === "#final" ? "Clear" : null} status={mode === "#final" ? "final" : mode === "#draft" ? "draft" : null} />
  </div>,
);
