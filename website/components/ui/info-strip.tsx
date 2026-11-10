import { Icon, type IconName } from "@/components/ui/icon";

// The navy horizontal band of key facts. Every value passed in comes from application data (lib/events.ts), never typed in here.

export type StripItem = { icon: IconName; ta: string; en: string };

export function InfoStrip({ items, label }: { items: readonly StripItem[]; label: string }) {
  return (
    <ul aria-label={label} className="on-navy grid grid-cols-2 gap-y-5 rounded-[1.75rem] bg-rio-navy px-4 py-5 text-white shadow-[0_24px_40px_-26px_rgb(23_59_120/0.8)] sm:px-6 lg:grid-cols-4 lg:gap-y-0">
      {items.map((it, i) => (
        <li key={it.en} className={`flex min-w-0 items-center gap-3 px-2 lg:px-5 ${i > 0 ? "lg:border-l lg:border-white/25" : ""} ${i % 2 === 1 ? "border-l border-white/25 pl-4 lg:pl-5" : ""}`}>
          <Icon name={it.icon} className="h-8 w-8 text-rio-pink-soft" />
          <p className="min-w-0 leading-snug">
            <span className="block font-bold [overflow-wrap:anywhere]">{it.ta}</span>
            <span lang="en" className="block text-sm text-white/90">
              {it.en}
            </span>
          </p>
        </li>
      ))}
    </ul>
  );
}
