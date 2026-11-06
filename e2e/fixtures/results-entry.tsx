// Browser entry for e2e/results-page.spec.ts: the REAL WinnersList in each state it can be given.
import { createRoot } from "react-dom/client";
import { WinnersList } from "@/components/results/winners-list";
import type { ResultsState } from "@/lib/results/public";

const mode = location.hash;
const long = "நீண்டபெயர்".repeat(6).slice(0, 60);
const states: Record<string, ResultsState> = {
  "#pending": { kind: "pending" },
  "#none": { kind: "published", winners: [] },
  "#unavailable": { kind: "unavailable" },
  "#published": {
    kind: "published",
    winners: [
      { eventId: 2, rank: 1, displayName: "Chitra", awardLabel: "First prize" },
      { eventId: 2, rank: 2, displayName: long, awardLabel: null },
      { eventId: 4, rank: 1, displayName: "Asha", awardLabel: "A very long award label that must wrap inside its card on a small screen without overflowing" },
    ],
  },
};

createRoot(document.getElementById("root")!).render(<WinnersList state={states[mode] ?? { kind: "pending" }} />);
