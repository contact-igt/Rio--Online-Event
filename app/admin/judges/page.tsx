import type { Metadata } from "next";
import { JudgeActiveButton } from "@/components/admin/judge-active-button";
import { JudgeResetButton } from "@/components/admin/judge-reset-button";
import { ProvisionJudgeForm } from "@/components/admin/provision-judge-form";
import { Bilingual } from "@/components/auth/bilingual";
import { Icon } from "@/components/ui/icon";
import { loadJudges, type JudgeRow, type JudgeStatus } from "@/lib/staff/judges";
import { createAuthLookup } from "@/lib/staff/invites";
import { provisioningReadiness } from "@/lib/staff/provisioning";
import { requireStaff } from "@/lib/staff/auth";
import { staff } from "@/lib/staff/messages";

export const metadata: Metadata = { title: "நடுவர்கள் · Judges", robots: { index: false } };
export const dynamic = "force-dynamic";

const M = staff.judges;
const th = "px-3 py-3 text-left text-sm font-semibold text-rio-navy";
const td = "px-3 py-3 align-middle";
const tone: Record<JudgeStatus, string> = { invited: "bg-rio-mist text-rio-navy", active: "bg-[#dff5e8] text-rio-ok", inactive: "bg-slate-100 text-rio-slate" };
const label: Record<JudgeStatus, string> = { invited: M.statusInvited, active: M.statusActive, inactive: M.statusInactive };

export default async function AdminJudgesPage() {
  const { supabase } = await requireStaff("admin"); // not an administrator: 404 (or the sign-in page when signed out)
  const readiness = provisioningReadiness();
  // E-mail addresses live in Supabase Auth and need the secret key; it is used here only to label rows, after the role check above.
  let lookup: ReturnType<typeof createAuthLookup> | null = null;
  if (readiness.secretKey === "ok") {
    try {
      lookup = createAuthLookup();
    } catch {
      lookup = null;
    }
  }
  const loaded = await loadJudges(supabase, lookup);
  const rows: JudgeRow[] = loaded?.rows ?? [];

  return (
    <section className="mx-auto w-full max-w-[1200px] px-4 py-[clamp(1.5rem,5vw,3rem)] sm:px-6 lg:px-8">
      <h1 className="text-[clamp(2rem,6vw,3rem)] font-extrabold">
        <Bilingual m={M.title} />
      </h1>
      <p className="mt-3 max-w-2xl text-lg">
        <Bilingual m={M.intro} />
      </p>

      <div className="card mt-6 p-4 sm:p-6">
        <h2 className="flex items-center gap-3 font-display text-2xl font-bold text-rio-navy">
          <Icon name="userCog" className="h-7 w-7 text-rio-rose" />
          <Bilingual m={M.add} />
        </h2>
        <div className="mt-4">
          <ProvisionJudgeForm enabled={readiness.enabled} secretKey={readiness.secretKey} />
        </div>
      </div>

      <div className="card mt-6 p-4 sm:p-6">
        <h2 className="flex items-center gap-3 font-display text-2xl font-bold text-rio-navy">
          <Icon name="users" className="h-7 w-7 text-rio-rose" />
          <Bilingual m={M.title} />
        </h2>
        {loaded === null && (
          <p role="alert" className="mt-3 font-semibold text-rio-error">
            The judge list could not be read right now. Try again.
          </p>
        )}
        {loaded && !loaded.emailsKnown && rows.length > 0 && (
          <p className="mt-3 flex items-start gap-3 rounded-2xl bg-rio-mist p-3 text-sm font-semibold text-rio-navy">
            <Icon name="info" className="mt-0.5 h-5 w-5 shrink-0" />
            <span>{M.noEmails}</span>
          </p>
        )}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[52rem] border-collapse">
            <caption className="sr-only">Judges, their status and scoring progress</caption>
            <thead>
              <tr className="bg-rio-mist">
                <th scope="col" className={`${th} rounded-l-xl`}>Judge</th>
                <th scope="col" className={th}>Email</th>
                <th scope="col" className={th}>Status</th>
                <th scope="col" className={th}>Assigned</th>
                <th scope="col" className={th}>Scoring progress</th>
                <th scope="col" className={`${th} rounded-r-xl`}>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className={`${td} text-rio-slate`}>
                    No judges exist yet. Add the first judge above once adding judges is switched on.
                  </td>
                </tr>
              )}
              {rows.map((j) => (
                <tr key={j.id} className="border-b border-rio-navy/10 align-top last:border-0">
                  <th scope="row" className={`${td} text-left`}>{j.name}</th>
                  <td className={`${td} break-all`}>{j.email ?? "–"}</td>
                  <td className={td}>
                    <span className={`inline-block rounded-full px-3 py-0.5 text-sm font-bold ${tone[j.status]}`}>{label[j.status]}</span>
                    {j.mustChangePassword && <span className="mt-1 block text-sm text-rio-slate">{M.mustChange}</span>}
                  </td>
                  <td className={td}>{j.assigned}</td>
                  <td className={td}>
                    <span className="flex items-center gap-2">
                      <progress value={j.progress ?? 0} max={100} aria-label={`${j.name} progress`} className="w-24" />
                      <span className="tabular-nums">{j.progress === null ? "–" : `${j.progress}%`}</span>
                    </span>
                    <span className="block text-sm text-rio-slate">
                      {j.final} final, {j.drafts} draft
                    </span>
                  </td>
                  <td className={td}>
                    <div className="flex flex-col items-start gap-2">
                      <JudgeActiveButton judgeId={j.id} name={j.name} active={j.status !== "inactive"} />
                      <JudgeResetButton judgeId={j.id} name={j.name} email={j.email} ready={readiness.ready} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
