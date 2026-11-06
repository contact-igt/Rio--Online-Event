import { Icon, eventIcon } from "@/components/ui/icon";
import { rules, type CompetitionEvent } from "@/lib/events";

// The competition the parent chose, beside the form: name, age band, video length, mode and the task. All of it comes from lib/events.ts.
// No poster or picture here; the supplied logo is in the header.

export function EventSummary({ event }: { event: CompetitionEvent }) {
  const facts = [
    { icon: "users", ta: "வயது வரம்பு", en: "Age band", value: `${event.minAge} – ${event.maxAge} years` },
    { icon: "video", ta: "வீடியோ நீளம்", en: "Video length", value: `${rules.videoSeconds.min} – ${rules.videoSeconds.max} seconds` },
    { icon: "laptop", ta: "முறை", en: "Mode", value: "Online" },
  ] as const;
  return (
    <aside aria-labelledby="summary-title" className="card-soft p-5 sm:p-6 lg:sticky lg:top-6">
      <div className="flex items-center gap-4">
        <span aria-hidden="true" className="grid size-14 shrink-0 place-items-center rounded-2xl bg-white text-rio-rose">
          <Icon name={eventIcon[event.slug] ?? "star"} className="h-8 w-8" />
        </span>
        <div className="min-w-0">
          <h2 id="summary-title" className="text-xl font-bold leading-snug [overflow-wrap:anywhere]">
            {event.nameTa}
          </h2>
          <p lang="en" className="font-display font-semibold text-rio-navy">
            {event.nameEn}
          </p>
        </div>
      </div>
      <ul className="mt-4 grid grid-cols-3 gap-2">
        {facts.map((f) => (
          <li key={f.en} className="flex min-w-0 flex-col items-center gap-0.5 rounded-2xl bg-white px-1.5 py-3 text-center">
            <Icon name={f.icon} className="h-6 w-6 text-rio-rose" />
            <span className="text-xs font-semibold leading-tight text-rio-navy">{f.ta}</span>
            <span lang="en" className="text-xs leading-tight text-rio-slate">
              {f.en}
            </span>
            <span lang="en" className="text-sm font-bold leading-tight text-rio-navy [overflow-wrap:anywhere]">
              {f.value}
            </span>
          </li>
        ))}
      </ul>
      <h3 className="mt-5 text-lg font-bold">
        இந்தப் போட்டியைப் பற்றி <span lang="en" className="text-rio-slate">/ About this competition</span>
      </h3>
      <p className="mt-1 [overflow-wrap:anywhere]">{event.taskTa}</p>
      <p lang="en" className="text-rio-slate">
        {event.taskEn}
      </p>
    </aside>
  );
}
