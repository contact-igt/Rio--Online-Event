import Link from "next/link";
import { registerPath } from "@/lib/auth/paths";
import type { OwnRegistration } from "@/lib/registration/drafts";
import { maskMobile } from "@/lib/registration/mask";
import { reg } from "@/lib/registration/messages";

export function DraftList({ slug, items, currentId, canEdit }: { slug: string; items: OwnRegistration[]; currentId: string | null; canEdit: boolean }) {
  if (items.length === 0) {
    return (
      <p className="text-rio-slate">
        {reg.list.empty.ta}
        <span lang="en" className="block">{reg.list.empty.en}</span>
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {items.map((r) => (
        <li key={r.id} className={`card !rounded-2xl p-4 ${r.id === currentId ? "ring-2 ring-rio-rose" : ""}`}>
          <p className="font-display text-xl font-bold text-rio-navy">{r.child_name}</p>
          <p className="text-rio-slate">
            {reg.list.age.ta} {r.child_age} · {maskMobile(r.parent_mobile)}
            <span lang="en" className="block">
              {reg.list.age.en} {r.child_age}
            </span>
          </p>
          <p className={`mt-2 inline-block rounded-full px-3 py-1 text-sm font-bold ${r.status === "finalized" ? "bg-rio-navy text-white" : "bg-rio-blush text-rio-navy"}`}>
            {(r.status === "finalized" ? reg.list.status.finalized : r.status === "uploaded" ? reg.list.status.uploaded : reg.list.status.draft).en}
            <span lang="ta" className="ml-1 font-medium"> / {(r.status === "finalized" ? reg.list.status.finalized : r.status === "uploaded" ? reg.list.status.uploaded : reg.list.status.draft).ta}</span>
          </p>
          <Link
            href={`${registerPath(slug)}?draft=${r.id}`}
            aria-current={r.id === currentId ? "true" : undefined}
            className="mt-2 inline-flex min-h-11 items-center font-semibold text-rio-rose underline underline-offset-4"
          >
            {(canEdit && r.status === "draft" ? reg.list.edit : reg.list.view).ta}
            <span lang="en">&nbsp;/ {(canEdit && r.status === "draft" ? reg.list.edit : reg.list.view).en}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
