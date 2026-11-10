import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { events } from "@/lib/events";
import { staff } from "@/lib/staff/messages";

// The judge's assigned entries, from the judge_entries view: anonymous code, competition and the judge's own score status only.
// The status is written in words as well as shown, so it never relies on colour.

export type JudgeRow = { entry_id: string; entry_code: string; event_id: number; score_status: "draft" | "final" | null; my_marks: string | number | null };

function Status({ s, marks }: { s: JudgeRow["score_status"]; marks: JudgeRow["my_marks"] }) {
  const m = s === "final" ? staff.judge.statusFinal : s === "draft" ? staff.judge.statusDraft : staff.judge.statusNone;
  const tone = s === "final" ? "text-rio-ok" : s === "draft" ? "text-rio-navy" : "text-rio-rose";
  return (
    <span className={`flex items-center gap-2 text-sm font-bold ${tone}`}>
      <Icon name={s === "final" ? "check" : "info"} className="h-5 w-5" />
      <span>
        {m.en} <span lang="ta" className="font-medium">/ {m.ta}</span>
        {marks !== null && s !== null && <span lang="en" className="block font-semibold tabular-nums text-rio-slate">{marks} / 100</span>}
      </span>
    </span>
  );
}

export function EntryList({ rows, currentId = null }: { rows: JudgeRow[]; currentId?: string | null }) {
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const e = events.find((x) => x.number === r.event_id);
        const current = r.entry_id === currentId;
        return (
          <li key={r.entry_id}>
            <Link
              href={`/judge/entries/${r.entry_id}`}
              aria-current={current ? "page" : undefined}
              className={`grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border-2 bg-white px-3 py-2.5 hover:border-rio-rose ${current ? "border-rio-rose bg-rio-blush" : "border-rio-navy/10"}`}
            >
              <Icon name="video" className="h-6 w-6 text-rio-rose" />
              <span className="min-w-0 leading-snug">
                <span className="block font-bold text-rio-navy [overflow-wrap:anywhere]">{r.entry_code}</span>
                <span className="block text-sm text-rio-slate [overflow-wrap:anywhere]">
                  {e ? e.nameTa : ""} <span lang="en">{e ? `/ ${e.nameEn}` : ""}</span>
                </span>
                <span className="mt-1 block">
                  <Status s={r.score_status} marks={r.my_marks} />
                </span>
              </span>
              <Icon name="chevron" className="h-4 w-4 text-rio-slate" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
