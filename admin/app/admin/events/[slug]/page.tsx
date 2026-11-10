import { ApiNotReady } from "@/components/admin/api-not-ready";
import { requireStaff } from "@/lib/staff/auth";

export const metadata = { title: "Competition · Admin", robots: { index: false } };

export default async function AdminEventPage() {
  await requireStaff("admin");
  return <ApiNotReady title="Competition" titleTa="போட்டி" />;
}
