import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AssignJudgeForm } from "@/components/admin/assign-judge-form";
import { ConfirmWinnerForm, RemoveWinnerButton } from "@/components/admin/winner-controls";
import { Bilingual } from "@/components/auth/bilingual";
import { formatDateBilingual } from "@/lib/registration/date";
import { getEvent } from "@/lib/events";
import { rankEntries } from "@/lib/judging/ranking";
import { createWinnerDb } from "@/lib/judging/winners";
import { requireStaff } from "@/lib/staff/auth";
import { staff } from "@/lib/staff/messages";

export const metadata: Metadata = { title: "போட்டி · Competition", robots: { index: false } };

const th = "px-3 py-2 text-left font-semibold text-rio-navy";
const td = "px-3 py-2 align-top";

export default async function AdminEventPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = getEvent(slug);
  if (!event) notFound();
  const { supabase } = await requireStaff("admin");

  const [entriesRes, judgesRes, winnersRes, settingsRes, scoring] = await Promise.all([
    // Administrators may read registrations. The child's name is shown only here, so the winner's display name can be typed by hand.
    supabase.from("submissions").select("id, entry_code, status, finalized_at, child_name, child_age, media_consent").eq("event_id", event.number).order("entry_code").limit(5000),
    supabase.from("judge_profiles").select("user_id, display_name").eq("active", true).order("display_name"),
    supabase.from("winners").select("id, submission_id, rank, award_label, display_name").eq("event_id", event.number).order("rank"),
    supabase.from("event_settings").select("results_publish_at").maybeSingle(),
    createWinnerDb(supabase).eventScoring(event.number),
  ]);
  const entries = entriesRes.data ?? [];
  const byId = new Map(entries.map((e) => [e.id as string, e]));
  const winners = winnersRes.data ?? [];
  const winnerOf = new Map(winners.map((w) => [w.submission_id as string, w]));
  const ranking = rankEntries(scoring.finalizedIds, scoring.assignments, scoring.scores);
  const publishAt = settingsRes.data?.results_publish_at as string | null | undefined;

  return (
    <section className="mx-auto w-full max-w-[1200px] px-4 py-[clamp(2rem,6vw,4rem)] sm:px-6 lg:px-8">
      <Link href="/admin" className="inline-flex min-h-11 items-center font-semibold text-rio-blue underline underline-offset-4">
        ← <Bilingual m={staff.admin.title} />
      </Link>
      <h1 className="mt-2 text-[clamp(1.75rem,5vw,2.5rem)] font-extrabold">
        {event.nameTa} <span lang="en" className="block text-rio-slate">{event.nameEn}</span>
      </h1>
      <p className="mt-3 max-w-2xl rounded-xl border-l-4 border-rio-pink bg-rio-blush p-3 font-semibold text-rio-navy">
        <Bilingual m={staff.admin.private} />
        <span className="mt-1 block font-medium">
          {publishAt ? `Publication is scheduled for ${formatDateBilingual(publishAt)}.` : "Publication is not scheduled."}
        </span>
      </p>

      <h2 id="assign" className="mt-10 scroll-mt-4 font-display text-2xl font-bold text-rio-navy">
        <Bilingual m={staff.admin.assign} />
      </h2>
      <div className="mt-3 max-w-xl">
        <AssignJudgeForm slug={event.slug} judges={(judgesRes.data ?? []).map((j) => ({ id: j.user_id as string, name: j.display_name as string }))} />
      </div>

      <h2 id="ranking" className="mt-10 scroll-mt-4 font-display text-2xl font-bold text-rio-navy">
        <Bilingual m={staff.admin.ranking} />
      </h2>
      <p className="text-rio-slate">Only entries that every assigned judge has finalized are ranked. Equal averages are flagged as ties and are never resolved automatically.</p>
      <div className="mt-3 card overflow-x-auto !rounded-2xl">
        <table className="w-full min-w-[44rem] border-collapse">
          <caption className="sr-only">Ranking of submitted entries</caption>
          <thead>
            <tr className="border-b border-rio-navy/15">
              <th scope="col" className={th}>Rank</th>
              <th scope="col" className={th}>Entry</th>
              <th scope="col" className={th}>Child (admin only)</th>
              <th scope="col" className={th}>Permission to share the first name</th>
              <th scope="col" className={th}>Average</th>
              <th scope="col" className={th}>Judges final / assigned</th>
              <th scope="col" className={th}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {ranking.length === 0 && (
              <tr>
                <td colSpan={7} className={td}>No entry has been submitted in this competition yet.</td>
              </tr>
            )}
            {ranking.map((r) => {
              const e = byId.get(r.submissionId);
              const won = winnerOf.get(r.submissionId);
              return (
                <tr key={r.submissionId} className="border-b border-rio-navy/10 align-top last:border-0">
                  <td className={td}>{r.rank ?? "–"}</td>
                  <th scope="row" className={`${td} text-left`}>{e?.entry_code}</th>
                  <td className={td}>{e ? `${e.child_name} (${e.child_age})` : ""}</td>
                  <td className={td}>{e ? (e.media_consent === true ? "Yes: given" : "No: not given") : ""}</td>
                  <td className={td}>{r.average ?? "–"}</td>
                  <td className={td}>{r.finalScores} / {r.assigned}</td>
                  <td className={td}>
                    {won ? <strong>Winner, rank {won.rank}</strong> : !r.complete ? (r.assigned === 0 ? "No judge assigned" : "Scoring incomplete") : r.tie ? <strong>Tie: administrator decides</strong> : "Ready"}
                    {r.complete && !won && (
                      <details className="mt-2">
                        <summary className="min-h-11 cursor-pointer font-semibold text-rio-blue">
                          <Bilingual m={staff.admin.confirmWinner} />
                        </summary>
                        <div className="mt-2">
                          <ConfirmWinnerForm slug={event.slug} submissionId={r.submissionId} tie={r.tie} suggestedRank={r.rank ?? 1} noSharePermission={e?.media_consent !== true} />
                        </div>
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2 id="winners" className="mt-10 scroll-mt-4 font-display text-2xl font-bold text-rio-navy">
        <Bilingual m={staff.admin.winners} />
      </h2>
      <ul className="mt-3 space-y-3">
        {winners.length === 0 && <li className="text-rio-slate">No winners confirmed yet.</li>}
        {winners.map((w) => (
          <li key={w.id as string} className="flex flex-wrap items-center gap-3 card !rounded-2xl p-3">
            <span className="font-display text-xl font-bold text-rio-navy">#{w.rank}</span>
            <span className="font-semibold">{w.display_name}</span>
            {w.award_label && <span className="text-rio-slate">{w.award_label}</span>}
            <span className="text-rio-slate">({byId.get(w.submission_id as string)?.entry_code})</span>
            <RemoveWinnerButton winnerId={w.id as string} />
          </li>
        ))}
      </ul>
    </section>
  );
}
