import type { Metadata } from "next";
import Link from "next/link";
import { Bilingual } from "@/components/auth/bilingual";
import { Icon, eventIcon, type IconName } from "@/components/ui/icon";
import { formatIst, TIME_ZONE } from "@/lib/admin/format";
import { events } from "@/lib/events";
import { isRegistrationOpen } from "@/lib/registration/settings";
import { requireStaff } from "@/lib/staff/auth";
import { staff } from "@/lib/staff/messages";

export const metadata: Metadata = { title: "நிர்வாகம் · Admin", robots: { index: false } };

const STATUSES = [
  { key: "draft", ta: "வரைவு", en: "Draft", tone: "bg-slate-100 text-rio-slate" },
  { key: "uploaded", ta: "பதிவேற்றம்", en: "Uploaded", tone: "bg-rio-mist text-rio-navy" },
  { key: "finalized", ta: "இறுதி", en: "Finalized", tone: "bg-[#dff5e8] text-rio-ok" },
  { key: "withdrawn", ta: "திரும்பப் பெற்றது", en: "Withdrawn", tone: "bg-rio-blush text-rio-rose" },
] as const;
const th = "px-3 py-3 text-left text-sm font-semibold text-rio-navy";
const td = "px-3 py-3 align-middle";

export default async function AdminPage() {
  const { supabase } = await requireStaff("admin");
  // Counts only: no child or parent field is selected on this screen. Every number below is counted from these rows.
  const [subs, judges, assignments, scores, winners, settingsRes] = await Promise.all([
    supabase.from("submissions").select("event_id, status").limit(5000),
    supabase.from("judge_profiles").select("user_id, display_name, active").order("display_name"),
    supabase.from("judge_assignments").select("judge_id").limit(5000),
    supabase.from("scores").select("judge_id, status").limit(5000),
    supabase.from("winners").select("id").limit(5000),
    supabase.from("event_settings").select("submissions_open_at, submissions_close_at, current_consent_version").maybeSingle(),
  ]);
  // Read-only: the registration window as configured in event_settings. Nothing on this screen changes it.
  const cfg = settingsRes.data as { submissions_open_at: string | null; submissions_close_at: string | null; current_consent_version: string | null } | null;
  const registrationOpen = isRegistrationOpen(cfg ? { opensAt: cfg.submissions_open_at, closesAt: cfg.submissions_close_at, consentVersion: cfg.current_consent_version } : null);
  const submissions = (subs.data ?? []) as { event_id: number; status: (typeof STATUSES)[number]["key"] }[];
  const count = (eventId: number, status: string) => submissions.filter((s) => s.event_id === eventId && s.status === status).length;
  const total = (status: string) => submissions.filter((s) => s.status === status).length;
  const judgeRows = judges.data ?? [];

  const metrics: { icon: IconName; value: number; ta: string; en: string }[] = [
    { icon: "users", value: submissions.length, ta: "மொத்தப் பதிவுகள்", en: "Total registrations" },
    { icon: "video", value: total("uploaded") + total("finalized"), ta: "பதிவேற்றப்பட்ட வீடியோக்கள்", en: "Uploaded videos" },
    { icon: "check", value: total("finalized"), ta: "இறுதிப் பதிவுகள்", en: "Finalized entries" },
    { icon: "user", value: judgeRows.filter((j) => j.active).length, ta: "செயலில் உள்ள நடுவர்கள்", en: "Judges active" },
    { icon: "trophy", value: (winners.data ?? []).length, ta: "உறுதிசெய்யப்பட்ட வெற்றியாளர்கள்", en: "Winners confirmed" },
  ];

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

      <ul aria-label="Summary" className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        {metrics.map((m) => (
          <li key={m.en} className="card flex min-w-0 flex-col gap-1 p-4">
            <span aria-hidden="true" className="grid size-10 place-items-center rounded-xl bg-rio-blush text-rio-rose">
              <Icon name={m.icon} className="h-6 w-6" />
            </span>
            <span className="font-display text-3xl font-bold leading-tight text-rio-navy tabular-nums">{m.value}</span>
            <span className="text-sm font-semibold leading-tight text-rio-navy [overflow-wrap:anywhere]">{m.ta}</span>
            <span lang="en" className="text-sm leading-tight text-rio-slate">
              {m.en}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] lg:items-start">
        <div className="min-w-0 space-y-6">
          <div id="event-settings" className="card scroll-mt-4 p-4 sm:p-6">
            <h2 className="flex items-center gap-3 font-display text-2xl font-bold text-rio-navy">
              <Icon name="calendar" className="h-7 w-7 text-rio-rose" />
              Event settings <span lang="ta" className="font-medium">/ நிகழ்வு அமைப்புகள்</span>
            </h2>
            <dl className="mt-3 divide-y divide-rio-navy/10">
              <div className="grid gap-x-4 py-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
                <dt className="text-rio-slate">Registration</dt>
                <dd className="font-semibold">
                  <span className={`inline-block rounded-full px-3 py-0.5 ${registrationOpen ? "bg-[#dff5e8] text-rio-ok" : "bg-slate-100 text-rio-slate"}`}>{registrationOpen ? "Open" : "Closed"}</span>
                </dd>
              </div>
              <div className="grid gap-x-4 py-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
                <dt className="text-rio-slate">Opening date and time</dt>
                <dd className="font-semibold text-rio-navy">{cfg?.submissions_open_at ? formatIst(cfg.submissions_open_at) : "Not configured"}</dd>
              </div>
              <div className="grid gap-x-4 py-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
                <dt className="text-rio-slate">Closing date and time</dt>
                <dd className="font-semibold text-rio-navy">{cfg?.submissions_close_at ? formatIst(cfg.submissions_close_at) : "Not configured"}</dd>
              </div>
              <div className="grid gap-x-4 py-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
                <dt className="text-rio-slate">Timezone</dt>
                <dd className="font-semibold text-rio-navy">
                  {TIME_ZONE} <span className="font-medium text-rio-slate">(IST, UTC+05:30)</span>
                </dd>
              </div>
            </dl>
            <p className="mt-3 flex items-start gap-3 rounded-2xl bg-rio-mist p-3 text-sm">
              <Icon name="lock" className="mt-0.5 h-5 w-5 shrink-0" />
              <span>Read-only. The registration dates cannot be changed from this screen. Registration is closed unless both dates and a consent wording are configured and the current time is inside the window.</span>
            </p>
          </div>

          <div id="competitions" className="card scroll-mt-4 p-4 sm:p-6">
            <h2 className="flex items-center gap-3 font-display text-2xl font-bold text-rio-navy">
              <Icon name="trophy" className="h-7 w-7 text-rio-rose" />
              <Bilingual m={staff.admin.competitions} />
            </h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[40rem] border-collapse">
                <caption className="sr-only">Entries by competition and status</caption>
                <thead>
                  <tr className="bg-rio-mist">
                    <th scope="col" className={`${th} rounded-l-xl`}>Competition</th>
                    {STATUSES.map((s) => (
                      <th key={s.key} scope="col" className={`${th} text-center`}>
                        {s.en}
                        <span lang="ta" className="block text-xs font-medium text-rio-slate">{s.ta}</span>
                      </th>
                    ))}
                    <th scope="col" className={`${th} rounded-r-xl text-center`}>Manage</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.number} className="border-b border-rio-navy/10 last:border-0">
                      <th scope="row" className={`${td} text-left`}>
                        <span className="flex items-center gap-3">
                          <Icon name={eventIcon[e.slug] ?? "star"} className="h-6 w-6 text-rio-rose" />
                          <span className="font-semibold text-rio-navy">
                            {e.nameTa} / <span lang="en">{e.nameEn}</span>
                          </span>
                        </span>
                      </th>
                      {STATUSES.map((s) => (
                        <td key={s.key} className={`${td} text-center`}>
                          <span className={`inline-block min-w-10 rounded-full px-3 py-0.5 font-bold tabular-nums ${s.tone}`}>{count(e.number, s.key)}</span>
                        </td>
                      ))}
                      <td className={`${td} text-center`}>
                        <Link href={`/admin/events/${e.slug}`} aria-label={`Manage ${e.nameEn}`} className="btn btn-outline min-h-11 !px-4 !py-1 text-sm">
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card p-4 sm:p-6">
            <h2 className="flex items-center gap-3 font-display text-2xl font-bold text-rio-navy">
              <Icon name="users" className="h-7 w-7 text-rio-rose" />
              <Bilingual m={staff.admin.judges} />
            </h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[36rem] border-collapse">
                <caption className="sr-only">Judges and scoring progress</caption>
                <thead>
                  <tr className="bg-rio-mist">
                    <th scope="col" className={`${th} rounded-l-xl`}>Judge</th>
                    <th scope="col" className={th}>Active</th>
                    <th scope="col" className={th}>Assigned</th>
                    <th scope="col" className={th}>Draft scores</th>
                    <th scope="col" className={th}>Final scores</th>
                    <th scope="col" className={`${th} rounded-r-xl`}>Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {judgeRows.length === 0 && (
                    <tr>
                      <td colSpan={6} className={`${td} text-rio-slate`}>
                        No judges exist yet. Judges are added by the organisers; once one is active, assign entries from a competition page.
                      </td>
                    </tr>
                  )}
                  {judgeRows.map((j) => {
                    const assigned = (assignments.data ?? []).filter((a) => a.judge_id === j.user_id).length;
                    const mine = (scores.data ?? []).filter((s) => s.judge_id === j.user_id);
                    const final = mine.filter((s) => s.status === "final").length;
                    const pct = assigned ? Math.round((final / assigned) * 100) : null;
                    return (
                      <tr key={j.user_id} className="border-b border-rio-navy/10 last:border-0">
                        <th scope="row" className={`${td} text-left`}>{j.display_name}</th>
                        <td className={td}>
                          <span className={`inline-block rounded-full px-3 py-0.5 font-bold ${j.active ? "bg-[#dff5e8] text-rio-ok" : "bg-slate-100 text-rio-slate"}`}>{j.active ? "Yes" : "No"}</span>
                        </td>
                        <td className={td}>{assigned}</td>
                        <td className={td}>{mine.length - final}</td>
                        <td className={td}>{final}</td>
                        <td className={td}>
                          <span className="flex items-center gap-2">
                            <progress value={pct ?? 0} max={100} aria-label={`${j.display_name} progress`} className="w-24" />
                            <span className="tabular-nums">{pct === null ? "–" : `${pct}%`}</span>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <aside className="card min-w-0 p-4 sm:p-6">
          <h2 className="flex items-center gap-3 font-display text-xl font-bold text-rio-navy">
            <Icon name="list" className="h-6 w-6 text-rio-rose" />
            <span>
              Management <span lang="ta" className="font-medium">/ நிர்வாகச் செயல்கள்</span>
            </span>
          </h2>
          <p className="mt-2 text-rio-slate">
            Assign judges, review rankings and confirm winners on each competition&apos;s page.
          </p>
          <ul className="mt-3">
            {[{ href: "/admin/registrations", label: "Registrations" }, { href: "/admin/judges", label: "Judges" }].map((l) => (
              <li key={l.href} className="border-t border-rio-navy/10 first:border-0">
                <Link href={l.href} className="flex min-h-11 items-center justify-between gap-2 font-semibold text-rio-navy hover:text-rio-rose">
                  <span>{l.label}</span>
                  <Icon name="chevron" className="h-4 w-4" />
                </Link>
              </li>
            ))}
            {events.map((e) => (
              <li key={e.slug} className="border-t border-rio-navy/10 first:border-0">
                <Link href={`/admin/events/${e.slug}`} className="flex min-h-11 items-center justify-between gap-2 font-semibold text-rio-navy hover:text-rio-rose">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{e.nameTa}</span>
                  <Icon name="chevron" className="h-4 w-4" />
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-4 flex items-start gap-3 rounded-2xl bg-rio-mist p-3 text-sm">
            <Icon name="info" className="mt-0.5 h-5 w-5 shrink-0" />
            <span>The registration window and result publication are not set on this screen.</span>
          </p>
        </aside>
      </div>
    </section>
  );
}
