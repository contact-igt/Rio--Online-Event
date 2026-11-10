import { ApiNotReady } from "@/components/admin/api-not-ready";
import { requireStaff } from "@/lib/staff/auth";

export const metadata = { title: "Entry · Judge", robots: { index: false } };

export default async function JudgeEntryPage() {
  await requireStaff("judge");
  return <ApiNotReady title="Entry review" titleTa="பதிவு ஆய்வு" back="/judge" />;
}
