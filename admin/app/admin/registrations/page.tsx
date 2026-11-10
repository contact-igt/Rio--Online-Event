import { ApiNotReady } from "@/components/admin/api-not-ready";
import { requireStaff } from "@/lib/staff/auth";

export const metadata = { title: "Registrations · Admin", robots: { index: false } };

export default async function AdminRegistrationsPage() {
  await requireStaff("admin");
  return <ApiNotReady title="Registrations" titleTa="பதிவுகள்" />;
}
