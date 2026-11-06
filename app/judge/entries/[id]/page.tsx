import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Bilingual } from "@/components/auth/bilingual";
import { EntryList, type JudgeRow } from "@/components/judge/entry-list";
import { PlaybackPanel } from "@/components/judge/playback-panel";
import { ScoreForm } from "@/components/judge/score-form";
import { Icon } from "@/components/ui/icon";
import { events } from "@/lib/events";
import { playbackAvailable } from "@/lib/judging/server";
import { requireStaff } from "@/lib/staff/auth";
import { staff } from "@/lib/staff/messages";
import { z } from "zod";

export const metadata: Metadata = { title: "பதிவு · Entry", robots: { index: false } };

export default async function JudgeEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { supabase } = await requireStaff("judge");
  // An entry that is not assigned to this judge, or not finalized, is simply absent from the view: the same 404 as an unknown id.
  const { data: entry } = await supabase
    .from("judge_entries")
    .select("entry_id, entry_code, event_id, score_status, my_marks, my_comments")
    .eq("entry_id", id)
    .maybeSingle();
  if (!entry) notFound();
  const event = events.find((e) => e.number === entry.event_id);
  // The list beside the review: the same anonymous view, this judge's rows only.
  const { data: all } = await supabase.from("judge_entries").select("entry_id, entry_code, event_id, score_status, my_marks").order("entry_code");

  return (
    <section className="mx-auto w-full max-w-[1200px] px-4 py-[clamp(1.25rem,4vw,2.5rem)] sm:px-6 lg:px-8">
      <Link href="/judge" className="inline-flex min-h-11 items-center font-semibold text-rio-rose underline underline-offset-4">
        <Bilingual m={staff.judge.back} />
      </Link>

      <div className="mt-3 grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
        <aside aria-labelledby="assigned-title" className="card hidden p-4 lg:block">
          <h2 id="assigned-title" className="text-xl font-bold">
            <Bilingual m={staff.judge.assigned} />
          </h2>
          <div className="mt-3">
            <EntryList rows={(all ?? []) as JudgeRow[]} currentId={entry.entry_id} />
          </div>
        </aside>

        <div className="card min-w-0 space-y-5 p-4 sm:p-6">
          <div className="flex items-start gap-4">
            <span aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-2xl bg-rio-blush text-rio-rose">
              <Icon name="video" className="h-7 w-7" />
            </span>
            <div className="min-w-0">
              <h1 className="text-[clamp(1.5rem,4vw,2rem)] font-extrabold">
                {staff.judge.review.ta} <span lang="en">/ {staff.judge.review.en}</span>
              </h1>
              <p lang="en" className="text-rio-slate">
                Entry ID: <span className="font-semibold text-rio-navy">{entry.entry_code}</span>
              </p>
            </div>
          </div>

          <p className="flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-3 font-semibold text-rio-navy">
            <Icon name="lock" className="mt-0.5 h-6 w-6 text-amber-700" />
            <Bilingual m={staff.judge.hidden} />
          </p>

          {event && (
            <ul className="grid gap-3 sm:grid-cols-2">
              <li className="flex min-w-0 items-center gap-3 rounded-2xl bg-rio-mist p-3">
                <Icon name="trophy" className="h-7 w-7 text-rio-rose" />
                <span className="min-w-0 leading-snug">
                  <span lang="en" className="block text-sm text-rio-slate">Competition</span>
                  <span className="block font-bold text-rio-navy [overflow-wrap:anywhere]">
                    {event.nameTa} <span lang="en">/ {event.nameEn}</span>
                  </span>
                </span>
              </li>
              <li className="flex min-w-0 items-center gap-3 rounded-2xl bg-rio-mist p-3">
                <Icon name="users" className="h-7 w-7 text-rio-rose" />
                <span className="min-w-0 leading-snug">
                  <span lang="en" className="block text-sm text-rio-slate">Age band</span>
                  <span lang="en" className="block font-bold text-rio-navy">{event.minAge} – {event.maxAge} years</span>
                </span>
              </li>
            </ul>
          )}

          <section aria-labelledby="video">
            <h2 id="video" className="mb-3 font-display text-xl font-bold text-rio-navy">
              <Bilingual m={staff.judge.video} />
            </h2>
            <PlaybackPanel entryId={entry.entry_id} available={playbackAvailable()} />
          </section>

          <section aria-labelledby="score" className="rounded-2xl bg-rio-mist/60 p-4">
            <h2 id="score" className="mb-3 font-display text-xl font-bold text-rio-navy">
              <Bilingual m={staff.judge.score} />
            </h2>
            <ScoreForm
              key={`${entry.score_status}-${entry.my_marks}`}
              entryId={entry.entry_id}
              marks={entry.my_marks === null ? null : Number(entry.my_marks)}
              comments={entry.my_comments}
              status={entry.score_status}
            />
          </section>
        </div>
      </div>
    </section>
  );
}
