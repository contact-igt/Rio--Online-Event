import type { Metadata } from "next";
import Link from "next/link";
import { Icon, type IconName } from "@/components/ui/icon";
import { formatIst } from "@/lib/admin/format";
import { countRegistrations, eventName, filterRegistrations, loadRegistrations, PAGE_SIZE, paginate, parseFilters, statusLabel, videoLabel, type RegStatus } from "@/lib/admin/registrations";
import { events } from "@/lib/events";
import { requireStaff } from "@/lib/staff/auth";

export const metadata: Metadata = { title: "பதிவுகள் · Registrations", robots: { index: false } };
export const dynamic = "force-dynamic";

const th = "px-3 py-3 text-left text-sm font-semibold text-rio-navy";
const td = "px-3 py-3 align-top";
const tone: Record<RegStatus, string> = { draft: "bg-slate-100 text-rio-slate", uploaded: "bg-rio-mist text-rio-navy", finalized: "bg-[#dff5e8] text-rio-ok", withdrawn: "bg-rio-blush text-rio-rose" };

export default async function AdminRegistrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Not an administrator: 404 (or the staff sign-in when signed out). Personal data below is read with this administrator's own session.
  const { supabase } = await requireStaff("admin");
  const filters = parseFilters(await searchParams);
  const all = await loadRegistrations(supabase);

  const counts = all ? countRegistrations(all) : null;
  const filtered = all ? filterRegistrations(all, filters) : [];
  const { items, pages, page } = paginate(filtered, filters.page);
  const tiles: { icon: IconName; value: number | null; label: string; note: string }[] = [
    { icon: "users", value: counts?.total ?? null, label: "Total registrations", note: "Every saved entry, including drafts" },
    { icon: "edit", value: counts?.draft ?? null, label: "Draft registrations", note: "Details saved, no video, not submitted" },
    { icon: "video", value: counts?.awaiting ?? null, label: "Awaiting video / finalization", note: "Video uploaded, not submitted yet" },
    { icon: "check", value: counts?.finalized ?? null, label: "Finalized entries", note: "The only completed submissions" },
    { icon: "list", value: counts?.withdrawn ?? null, label: "Withdrawn entries", note: "Withdrawn by the parent" },
  ];
  const keep = (extra: Record<string, string | number>) => {
    const p = new URLSearchParams();
    if (filters.q) p.set("q", filters.q);
    if (filters.status) p.set("status", filters.status);
    if (filters.event !== null) p.set("event", String(filters.event));
    for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
    return `/admin/registrations?${p.toString()}`;
  };

  return (
    <section className="mx-auto w-full max-w-[1200px] px-4 py-[clamp(1.5rem,5vw,3rem)] sm:px-6 lg:px-8">
      <h1 className="text-[clamp(2rem,6vw,3rem)] font-extrabold">
        பதிவுகள் <span lang="en" className="block text-rio-slate">Registrations</span>
      </h1>
      <p className="mt-3 flex max-w-3xl items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 font-semibold text-rio-navy">
        <Icon name="lock" className="mt-0.5 h-6 w-6 shrink-0 text-amber-700" />
        <span>
          This screen shows children&apos;s and parents&apos; personal data. It is for administrators only; do not copy, share or screenshot it outside the event team. A draft is not a submission: only Finalized entries are complete.
        </span>
      </p>

      {all === null && (
        <p role="alert" className="mt-4 font-semibold text-rio-error">
          The registrations could not be read right now. Try again.
        </p>
      )}

      <ul aria-label="Summary" className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        {tiles.map((t) => (
          <li key={t.label} className="card flex min-w-0 flex-col gap-1 p-4">
            <span aria-hidden="true" className="grid size-10 place-items-center rounded-xl bg-rio-blush text-rio-rose">
              <Icon name={t.icon} className="h-6 w-6" />
            </span>
            <span className="font-display text-3xl font-bold leading-tight text-rio-navy tabular-nums">{t.value ?? "–"}</span>
            <span className="text-sm font-semibold leading-tight text-rio-navy">{t.label}</span>
            <span className="text-xs leading-tight text-rio-slate">{t.note}</span>
          </li>
        ))}
      </ul>

      <form method="get" action="/admin/registrations" role="search" className="card mt-6 grid gap-4 p-4 sm:grid-cols-2 sm:p-6 lg:grid-cols-[minmax(0,2fr)_1fr_1fr_auto]">
        <div>
          <label htmlFor="q" className="block font-semibold text-rio-navy">Search</label>
          <input id="q" name="q" type="search" defaultValue={filters.q} maxLength={100} placeholder="Reference, child, parent, e-mail or mobile" autoComplete="off" className="field mt-2" />
        </div>
        <div>
          <label htmlFor="event" className="block font-semibold text-rio-navy">Competition</label>
          <select id="event" name="event" defaultValue={filters.event ?? ""} className="field mt-2">
            <option value="">All competitions</option>
            {events.map((e) => (
              <option key={e.number} value={e.number}>
                {e.nameEn}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="status" className="block font-semibold text-rio-navy">Status</label>
          <select id="status" name="status" defaultValue={filters.status} className="field mt-2">
            <option value="">All statuses</option>
            {(Object.keys(statusLabel) as RegStatus[]).map((s) => (
              <option key={s} value={s}>
                {statusLabel[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-2">
          <button type="submit" className="btn btn-primary w-full sm:w-auto">Search</button>
          <Link href="/admin/registrations" className="btn btn-outline w-full sm:w-auto">Clear</Link>
        </div>
      </form>

      <div className="card mt-6 p-4 sm:p-6">
        <p role="status" className="font-semibold text-rio-navy">
          {all === null ? "" : `${filtered.length} of ${all.length} registrations`}
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[64rem] border-collapse">
            <caption className="sr-only">Registrations</caption>
            <thead>
              <tr className="bg-rio-mist">
                <th scope="col" className={`${th} rounded-l-xl`}>Reference</th>
                <th scope="col" className={th}>Child</th>
                <th scope="col" className={th}>Competition</th>
                <th scope="col" className={th}>Parent</th>
                <th scope="col" className={th}>Registration status</th>
                <th scope="col" className={th}>Video</th>
                <th scope="col" className={th}>Submitted</th>
                <th scope="col" className={`${th} rounded-r-xl`}>Details</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={8} className={`${td} text-rio-slate`}>
                    {all && all.length === 0 ? "No registrations exist yet." : "No registration matches. Change or clear the search."}
                  </td>
                </tr>
              )}
              {items.map((r) => (
                <tr key={r.id} className="border-b border-rio-navy/10 last:border-0">
                  <th scope="row" className={`${td} text-left font-mono text-sm`}>{r.entryCode}</th>
                  <td className={td}>
                    {r.childName} <span className="text-rio-slate">({r.childAge})</span>
                  </td>
                  <td className={td}>{eventName(r.eventId)?.nameEn ?? r.eventId}</td>
                  <td className={td}>{r.parentName}</td>
                  <td className={td}>
                    <span className={`inline-block rounded-full px-3 py-0.5 text-sm font-bold ${tone[r.status]}`}>{statusLabel[r.status]}</span>
                  </td>
                  <td className={td}>{videoLabel(r)}</td>
                  <td className={td}>{r.finalizedAt ? formatIst(r.finalizedAt) : <span className="text-rio-slate">Not submitted</span>}</td>
                  <td className={td}>
                    <Link href={`/admin/registrations/${r.id}`} aria-label={`Details for ${r.entryCode}`} className="btn btn-outline min-h-11 !px-4 !py-1 text-sm">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <nav aria-label="Pages" className="mt-4 flex items-center justify-between gap-3">
            {page > 1 ? (
              <Link href={keep({ page: page - 1 })} className="btn btn-outline min-h-11 !py-1">Previous</Link>
            ) : (
              <span />
            )}
            <span className="text-sm font-semibold text-rio-navy">
              Page {page} of {pages} ({PAGE_SIZE} per page)
            </span>
            {page < pages ? (
              <Link href={keep({ page: page + 1 })} className="btn btn-outline min-h-11 !py-1">Next</Link>
            ) : (
              <span />
            )}
          </nav>
        )}
      </div>
    </section>
  );
}
