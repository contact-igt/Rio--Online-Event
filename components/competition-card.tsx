import Link from "next/link";
import { Icon, eventIcon } from "@/components/ui/icon";
import type { CompetitionEvent } from "@/lib/events";

// One competition, read from lib/events.ts. Used by the landing page (preview, one link) and the competitions page (age-aware, with the
// register link). `fit` is only set once a parent has picked an age: "yes" shows an Eligible badge, "no" says plainly that the child's age
// is outside this competition and removes the Register link, so nobody is sent into a form that will refuse them.

export type Fit = "unknown" | "yes" | "no";

export function CompetitionCard({ event, index = 0, fit = "unknown", age = null, showRegister = false, open = false }: { event: CompetitionEvent; index?: number; fit?: Fit; age?: number | null; showRegister?: boolean; open?: boolean }) {
  const no = fit === "no";
  return (
    <li
      id={`event-${event.slug}`}
      style={{ "--i": index } as React.CSSProperties}
      data-fit={fit}
      className={`rise lift card flex min-w-0 flex-col gap-3 p-5 ${fit === "yes" ? "ring-2 ring-rio-pink" : ""} ${no ? "!bg-slate-50" : ""}`}
    >
      <div className="flex items-start gap-4">
        <span aria-hidden="true" className={`grid size-14 shrink-0 place-items-center rounded-2xl ${no ? "bg-slate-200 text-rio-slate" : "bg-rio-blush text-rio-rose"}`}>
          <Icon name={eventIcon[event.slug] ?? "star"} className="h-8 w-8" />
        </span>
        <div className="min-w-0">
          <h3 className="text-[1.35rem] font-bold leading-snug [overflow-wrap:anywhere]">{event.nameTa}</h3>
          <p lang="en" className="font-display text-lg font-semibold text-rio-navy">
            {event.nameEn}
          </p>
        </div>
      </div>

      <p className="chip self-start">
        <Icon name="users" className="h-4 w-4 text-rio-rose" />
        <span>
          வயது / <span lang="en">Age:</span> <span lang="en" className="tabular-nums">{event.minAge}–{event.maxAge}</span> ஆண்டுகள் / <span lang="en">years</span>
        </span>
      </p>

      <div className="min-w-0 flex-1">
        <p className="[overflow-wrap:anywhere]">{event.taskTa}</p>
        <p lang="en" className="text-rio-slate">
          {event.taskEn}
        </p>
      </div>

      {fit === "yes" && (
        <p role="status" className="font-bold text-rio-ok">
          <Icon name="check" className="mr-1 inline h-5 w-5 align-text-bottom" />
          தகுதியானது <span lang="en" className="font-semibold">/ Eligible for age {age}</span>
        </p>
      )}
      {no && (
        <p role="status" className="font-bold text-rio-error">
          தகுதியில்லை <span lang="en" className="font-semibold">/ Not eligible: this competition is for ages {event.minAge}–{event.maxAge}, not age {age}</span>
        </p>
      )}

      <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {showRegister && !no && open && (
          <Link href={`/events/${event.slug}/register`} className="btn btn-primary min-h-11 flex-1 !py-1.5">
            <span>
              பதிவு செய்க <span lang="en" className="font-semibold">/ Register</span>
            </span>
          </Link>
        )}
        <Link href={`/events/${event.slug}`} aria-label={`${event.nameTa}: விவரங்களைப் பார்க்க / View details`} className="btn btn-outline min-h-11 flex-1 !py-1.5">
          <span>
            விவரங்கள் <span lang="en" className="font-semibold">/ View details</span>
          </span>
          <Icon name="arrow" className="h-4 w-4" />
        </Link>
      </div>
    </li>
  );
}
