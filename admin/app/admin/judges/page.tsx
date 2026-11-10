import { ApiNotReady } from "@/components/admin/api-not-ready";
import { requireStaff } from "@/lib/staff/auth";

export const metadata = { title: "Judges · Admin", robots: { index: false } };

export default async function AdminJudgesPage() {
  await requireStaff("admin");
  return <ApiNotReady title="Judges" titleTa="நடுவர்கள்" />;
}
