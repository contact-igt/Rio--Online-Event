import { ApiNotReady } from "@/components/admin/api-not-ready";
import { requireStaff } from "@/lib/staff/auth";

export const metadata = { title: "Registration · Admin", robots: { index: false } };

export default async function AdminRegistrationPage() {
  await requireStaff("admin");
  return <ApiNotReady title="Registration" titleTa="பதிவு" back="/admin/registrations" />;
}
