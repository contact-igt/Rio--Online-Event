"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/icon";

// The administrator sidebar (a wrapping row of buttons on phones). Every entry opens something that already exists: a screen, or a
// section of the competition page (assign, ranking, winners). On a competition page those three jump to that page's own sections; elsewhere
// they open the dashboard's competition list, where each competition links to them. It only shows for a verified administrator (the layout
// checks), and every page behind it checks the role again on the server.

type Item = { label: string; ta: string; icon: IconName; href: (onEvent: string | null) => string; active?: (path: string) => boolean };

const items: Item[] = [
  { label: "Dashboard", ta: "முகப்பு", icon: "list", href: () => "/admin", active: (p) => p === "/admin" },
  { label: "Registrations", ta: "பதிவுகள்", icon: "clipboard", href: () => "/admin/registrations", active: (p) => p.startsWith("/admin/registrations") },
  { label: "Judges", ta: "நடுவர்கள்", icon: "user", href: () => "/admin/judges", active: (p) => p.startsWith("/admin/judges") },
  { label: "Assign Judges", ta: "நடுவரை ஒதுக்கு", icon: "users", href: (e) => (e ? `${e}#assign` : "/admin#competitions") },
  { label: "Scoring", ta: "மதிப்பெண்", icon: "star", href: (e) => (e ? `${e}#ranking` : "/admin#competitions") },
  { label: "Results", ta: "முடிவுகள்", icon: "trophy", href: (e) => (e ? `${e}#winners` : "/admin#competitions") },
  { label: "Event Settings", ta: "நிகழ்வு அமைப்புகள்", icon: "calendar", href: () => "/admin#event-settings" },
];

export function AdminNav() {
  const path = usePathname() ?? "/admin";
  const onEvent = path.startsWith("/admin/events/") ? path : null;
  return (
    <nav aria-label="Administration" className="px-4 pt-4 sm:px-6 lg:sticky lg:top-4 lg:self-start lg:px-0 lg:pl-6 lg:pt-8">
      <ul className="flex flex-wrap gap-2 lg:card lg:flex-col lg:gap-1 lg:!rounded-2xl lg:p-2">
        {items.map((it) => {
          const current = it.active?.(path) ?? false;
          return (
            <li key={it.label} className="lg:w-full">
              <Link
                href={it.href(onEvent)}
                aria-current={current ? "page" : undefined}
                className={`flex min-h-11 items-center gap-2 rounded-full px-4 py-1 font-semibold leading-tight lg:rounded-xl ${current ? "bg-rio-rose text-white" : "bg-white text-rio-navy hover:bg-rio-blush lg:bg-transparent"}`}
              >
                <Icon name={it.icon} className="h-5 w-5" />
                <span>
                  {it.label}
                  <span lang="ta" className={`block text-xs font-medium ${current ? "text-white" : "text-rio-slate"}`}>{it.ta}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
