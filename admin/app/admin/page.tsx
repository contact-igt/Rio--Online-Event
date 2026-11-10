import type { Metadata } from "next";
import Link from "next/link";
import { Bilingual } from "@/components/auth/bilingual";
import { Icon, eventIcon } from "@/components/ui/icon";
import { events } from "@/lib/events";
import { requireStaff } from "@/lib/staff/auth";
import { staff } from "@/lib/staff/messages";

export const metadata: Metadata = { title: "நிர்வாகம் · Admin", robots: { index: false } };
export const dynamic = "force-dynamic";

// The Express API has no endpoints yet for registrations, judges, scores or event settings, so this page shows none of them: no counts, no
// dates, nothing invented. It shows who is signed in (from the API) and the six fixed competitions.
export default async function AdminPage() {
  const { user } = await requireStaff("admin");

  return (
    <section className="mx-auto w-full max-w-[1200px] px-4 py-[clamp(1.5rem,5vw,3rem)] sm:px-6 lg:px-8">
      <p lang="en" className="eyebrow">
        <span aria-hidden="true" className="h-px w-8 bg-current" />
        Children&apos;s Day Celebration 2026
      </p>
      <h1 className="mt-2 text-[clamp(2rem,6vw,3.25rem)] font-extrabold">
        <Bilingual m={staff.admin.title} />
      </h1>
      <p className="mt-4 flex max-w-3xl items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 font-semibold text-rio-navy">
        <Icon name="info" className="mt-0.5 h-6 w-6 text-amber-700" />
        <Bilingual m={staff.admin.private} />
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] lg:items-start">
        <div className="min-w-0 space-y-6">
          <div className="card p-4 sm:p-6">
            <h2 className="flex items-center gap-3 font-display text-2xl font-bold text-rio-navy">
              <Icon name="user" className="h-7 w-7 text-rio-rose" />
              Signed in <span lang="ta" className="font-medium">/ உள்நுழைந்தவர்</span>
            </h2>
            <dl className="mt-3 divide-y divide-rio-navy/10">
              <div className="grid gap-x-4 py-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
                <dt className="text-rio-slate">Name</dt>
                <dd className="font-semibold text-rio-navy">{user.displayName}</dd>
              </div>
              <div className="grid gap-x-4 py-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
                <dt className="text-rio-slate">Email</dt>
                <dd className="font-semibold text-rio-navy [overflow-wrap:anywhere]">{user.email}</dd>
              </div>
              <div className="grid gap-x-4 py-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
                <dt className="text-rio-slate">Role</dt>
                <dd className="font-semibold text-rio-navy">Administrator</dd>
              </div>
            </dl>
          </div>

          <div className="card p-4 sm:p-6">
            <h2 className="flex items-center gap-3 font-display text-2xl font-bold text-rio-navy">
              <Icon name="calendar" className="h-7 w-7 text-rio-rose" />
              Registrations, judges and scores <span lang="ta" className="font-medium">/ பதிவுகள்</span>
            </h2>
            <p role="status" className="mt-3 flex items-start gap-3 rounded-2xl bg-rio-mist p-3">
              <Icon name="info" className="mt-0.5 h-5 w-5 shrink-0" />
              <span>
                Not available yet. The counts, event settings, judges and scoring progress will appear here when the new server provides them. Registration is closed.
                <span lang="ta" className="mt-1 block text-sm">இந்தத் தரவு இன்னும் தயாராகவில்லை. பதிவு மூடப்பட்டுள்ளது.</span>
              </span>
            </p>
          </div>

          <div id="competitions" className="card scroll-mt-4 p-4 sm:p-6">
            <h2 className="flex items-center gap-3 font-display text-2xl font-bold text-rio-navy">
              <Icon name="trophy" className="h-7 w-7 text-rio-rose" />
              <Bilingual m={staff.admin.competitions} />
            </h2>
            <ul className="mt-4 divide-y divide-rio-navy/10">
              {events.map((e) => (
                <li key={e.slug}>
                  <Link href={`/admin/events/${e.slug}`} className="flex min-h-11 items-center justify-between gap-3 py-2 font-semibold text-rio-navy hover:text-rio-rose">
                    <span className="flex min-w-0 items-center gap-3">
                      <Icon name={eventIcon[e.slug] ?? "star"} className="h-6 w-6 shrink-0 text-rio-rose" />
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        {e.nameTa} / <span lang="en">{e.nameEn}</span>
                      </span>
                    </span>
                    <Icon name="chevron" className="h-4 w-4 shrink-0" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <aside className="card min-w-0 p-4 sm:p-6">
          <h2 className="flex items-center gap-3 font-display text-xl font-bold text-rio-navy">
            <Icon name="list" className="h-6 w-6 text-rio-rose" />
            <span>
              Management <span lang="ta" className="font-medium">/ நிர்வாகச் செயல்கள்</span>
            </span>
          </h2>
          <ul className="mt-3">
            {[{ href: "/admin/registrations", label: "Registrations" }, { href: "/admin/judges", label: "Judges" }].map((l) => (
              <li key={l.href} className="border-t border-rio-navy/10 first:border-0">
                <Link href={l.href} className="flex min-h-11 items-center justify-between gap-2 font-semibold text-rio-navy hover:text-rio-rose">
                  <span>{l.label}</span>
                  <Icon name="chevron" className="h-4 w-4" />
                </Link>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </section>
  );
}
