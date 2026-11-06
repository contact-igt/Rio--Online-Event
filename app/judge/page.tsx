import type { Metadata } from "next";
import { Bilingual } from "@/components/auth/bilingual";
import { EntryList, type JudgeRow } from "@/components/judge/entry-list";
import { Icon } from "@/components/ui/icon";
import { requireStaff } from "@/lib/staff/auth";
import { staff } from "@/lib/staff/messages";

export const metadata: Metadata = { title: "நடுவர் · Judge", robots: { index: false } };

export default async function JudgePage() {
  const { supabase } = await requireStaff("judge");
  // judge_entries is the only thing a judge can read about entries: anonymous code, competition, own marks. No child or parent data.
  const { data } = await supabase.from("judge_entries").select("entry_id, entry_code, event_id, score_status, my_marks").order("entry_code");
  const rows = (data ?? []) as JudgeRow[];
  const done = rows.filter((r) => r.score_status === "final").length;
  const drafts = rows.filter((r) => r.score_status === "draft").length;

  const tiles = [
    { ta: staff.judge.assigned.ta, en: staff.judge.assigned.en, value: rows.length },
    { ta: staff.judge.statusFinal.ta, en: staff.judge.statusFinal.en, value: done },
    { ta: staff.judge.statusDraft.ta, en: staff.judge.statusDraft.en, value: drafts },
    { ta: staff.judge.statusNone.ta, en: staff.judge.statusNone.en, value: rows.length - done - drafts },
  ];

  return (
    <section className="mx-auto w-full max-w-[1200px] px-4 py-[clamp(1.5rem,5vw,3rem)] sm:px-6 lg:px-8">
      <p lang="en" className="eyebrow">
        <span aria-hidden="true" className="h-px w-8 bg-current" />
        Children&apos;s Day Celebration 2026
      </p>
      <h1 className="mt-2 text-[clamp(2rem,6vw,3.25rem)] font-extrabold">
        <Bilingual m={staff.judge.title} />
      </h1>
      <p className="mt-3 max-w-2xl text-lg">
        <Bilingual m={staff.judge.intro} />
      </p>

      {rows.length === 0 ? (
        <p className="card-soft mt-8 flex items-start gap-3 p-5 font-semibold text-rio-navy">
          <Icon name="info" className="mt-0.5 h-6 w-6 text-rio-rose" />
          <Bilingual m={staff.judge.none} />
        </p>
      ) : (
        <>
          <ul aria-label="Summary" className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {tiles.map((t) => (
              <li key={t.en} className="card flex min-w-0 flex-col gap-0.5 p-4">
                <span className="font-display text-3xl font-bold leading-tight text-rio-navy tabular-nums">{t.value}</span>
                <span className="text-sm font-semibold leading-tight text-rio-navy [overflow-wrap:anywhere]">{t.ta}</span>
                <span lang="en" className="text-sm leading-tight text-rio-slate">
                  {t.en}
                </span>
              </li>
            ))}
          </ul>
          <div className="card mt-6 p-4 sm:p-6">
            <h2 className="flex items-center gap-3 text-2xl font-bold">
              <Icon name="list" className="h-7 w-7 text-rio-rose" />
              <Bilingual m={staff.judge.assigned} />
            </h2>
            <div className="mt-4">
              <EntryList rows={rows} />
            </div>
          </div>
        </>
      )}
    </section>
  );
}
