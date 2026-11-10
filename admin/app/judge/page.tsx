import { ApiNotReady } from "@/components/admin/api-not-ready";
import { requireStaff } from "@/lib/staff/auth";

export const metadata = { title: "Judge · Rio", robots: { index: false } };

export default async function JudgePage() {
  await requireStaff("judge");
  return <ApiNotReady title="Judge area" titleTa="நடுவர் பக்கம்" back="/staff/login" />;
}
