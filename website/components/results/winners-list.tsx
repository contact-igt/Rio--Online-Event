import { Bilingual } from "@/components/auth/bilingual";
import { events } from "@/lib/events";
import { results } from "@/lib/results/messages";
import type { ResultsState } from "@/lib/results/public";

// What the public sees. It renders exactly the state it is given: before publication there is no winner markup at all.
export function WinnersList({ state }: { state: ResultsState }) {
  if (state.kind === "unavailable") {
    return (
      <p role="status" className="rounded-xl border-l-4 border-rio-pink bg-rio-blush p-4 font-semibold text-rio-navy">
        <Bilingual m={results.unavailable} />
      </p>
    );
  }
  if (state.kind === "pending") {
    return (
      <p className="rounded-xl border-l-4 border-rio-pink bg-rio-blush p-4 text-lg font-semibold text-rio-navy">
        <Bilingual m={results.pending} />
      </p>
    );
  }
  if (state.winners.length === 0) {
    return (
      <p className="rounded-xl border-l-4 border-rio-pink bg-rio-blush p-4 font-semibold text-rio-navy">
        <Bilingual m={results.none} />
      </p>
    );
  }
  return (
    <div className="space-y-10">
      {events
        .filter((e) => state.winners.some((w) => w.eventId === e.number))
        .map((e) => (
          <section key={e.number} aria-labelledby={`results-${e.number}`}>
            <h2 id={`results-${e.number}`} className="font-heading text-2xl font-bold text-rio-navy">
              {e.nameTa} <span lang="en" className="block text-lg font-medium text-rio-slate">{e.nameEn}</span>
            </h2>
            <ol className="mt-4 grid gap-3 sm:grid-cols-2">
              {state.winners
                .filter((w) => w.eventId === e.number)
                .map((w) => (
                  <li key={w.rank} className="flex min-w-0 items-center gap-4 rounded-2xl border border-rio-navy/15 bg-rio-blush p-4">
                    <span className="grid size-12 shrink-0 place-items-center rounded-full bg-rio-navy font-display text-xl font-bold text-white">
                      <span className="sr-only">
                        {results.place.ta} / {results.place.en}{" "}
                      </span>
                      {w.rank}
                    </span>
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      <span className="block text-lg font-bold text-rio-navy">{w.displayName}</span>
                      {w.awardLabel && <span className="block text-rio-slate">{w.awardLabel}</span>}
                    </span>
                  </li>
                ))}
            </ol>
          </section>
        ))}
    </div>
  );
}
