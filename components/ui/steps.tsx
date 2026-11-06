import { Icon, type IconName } from "./icon";

// "How it works": numbered cards joined by chevrons on wide screens, a plain grid on phones. Content is passed in, so the landing page and the
// competitions page can say slightly different things without two copies of the layout.

export type Step = { ta: string; en: string; icon: IconName };

export function Steps({ steps, label }: { steps: readonly Step[]; label: string }) {
  return (
    <ol aria-label={label} className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-[repeat(4,minmax(0,1fr))] lg:gap-0">
      {steps.map((s, i) => (
        <li key={s.en} className="relative min-w-0 lg:px-2">
          <div className="card lift flex h-full min-w-0 flex-col items-center gap-1 px-3 pb-5 pt-7 text-center">
            <span aria-hidden="true" className="absolute left-1/2 top-0 grid size-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-rio-rose font-display font-bold text-white lg:left-1/2">
              {i + 1}
            </span>
            <Icon name={s.icon} className="h-9 w-9 text-rio-rose" />
            <p className="mt-1 font-bold leading-snug text-rio-navy [overflow-wrap:anywhere]">{s.ta}</p>
            <p lang="en" className="text-sm leading-snug text-rio-slate">
              {s.en}
            </p>
          </div>
          {i < steps.length - 1 && <Icon name="chevron" className="absolute -right-2.5 top-1/2 z-10 hidden h-5 w-5 -translate-y-1/2 text-rio-rose lg:block" />}
        </li>
      ))}
    </ol>
  );
}
