"use client";

import { useState } from "react";
import { CompetitionCard } from "@/components/competition-card";
import { Icon } from "@/components/ui/icon";
import { AGES, events, fitsAge } from "@/lib/events";

// The age filter and the six cards on /competitions. Pick an age and every card says Eligible or Not eligible; nothing is hidden, so a
// parent can see why. Picking the same age again clears the filter. Ages and bands come from lib/events.ts.

export function CompetitionBrowser({ open }: { open: boolean }) {
  const [age, setAge] = useState<number | null>(null);
  const fitting = age === null ? 0 : events.filter((e) => fitsAge(e, age)).length;

  return (
    <div>
      <div className="card-soft flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-center">
        <p id="age-label" className="flex min-w-0 items-center gap-3 font-bold text-rio-navy lg:w-56 lg:shrink-0">
          <Icon name="users" className="h-8 w-8 text-rio-rose" />
          <span>
            குழந்தையின் வயது
            <span lang="en" className="block text-sm font-semibold text-rio-slate">
              Child&apos;s age
            </span>
          </span>
        </p>
        <div role="group" aria-labelledby="age-label" className="flex flex-wrap gap-2">
          {AGES.map((a) => (
            <button
              key={a}
              type="button"
              aria-pressed={age === a}
              onClick={() => setAge(age === a ? null : a)}
              className={`min-h-11 min-w-11 rounded-full border-2 px-3 font-display text-lg font-bold tabular-nums transition-colors duration-150 active:scale-[0.97] ${
                age === a ? "border-rio-rose bg-rio-rose text-white" : "border-rio-line bg-white text-rio-navy hover:border-rio-rose hover:bg-rio-blush"
              }`}
            >
              {a}
            </button>
          ))}
        </div>
      </div>
      <p role="status" lang="en" className="mt-3 min-h-7 text-center font-semibold text-rio-navy">
        {age === null ? "" : fitting === 0 ? `No competition accepts age ${age}.` : `${fitting} of ${events.length} competitions accept age ${age}.`}
      </p>

      {!open && (
        <p className="card-soft mx-auto mt-4 max-w-2xl px-4 py-3 text-center font-semibold text-rio-navy">
          பதிவு விரைவில் தொடங்கும் <span lang="en" className="font-medium text-rio-slate">/ Registration opens soon. You can read every competition&apos;s details now.</span>
        </p>
      )}

      <ol className="mt-4 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
        {events.map((e, i) => (
          <CompetitionCard key={e.slug} event={e} index={i} fit={age === null ? "unknown" : fitsAge(e, age) ? "yes" : "no"} age={age} showRegister open={open} />
        ))}
      </ol>
    </div>
  );
}
