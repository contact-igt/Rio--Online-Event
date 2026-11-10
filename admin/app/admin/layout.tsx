import { AdminNav } from "@/components/admin/admin-nav";
import { StaffBar } from "@/components/staff/staff-bar";
import { staffSession } from "@/lib/staff/auth";

// The sidebar and bar appear only for a verified administrator, so a parent or judge who lands on a 404 under /admin is shown nothing that
// reveals the area. This is only what is displayed: every admin page and every admin action checks the role again on the server.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const verified = (await staffSession("admin")) !== null;
  return (
    <div className="wash min-h-[60vh]">
      {verified && <StaffBar role="admin" verified />}
      <div className="mx-auto grid w-full max-w-[1400px] lg:grid-cols-[15rem_minmax(0,1fr)]">
        {verified && <AdminNav />}
        <div className="min-w-0 lg:col-start-2">{children}</div>
      </div>
    </div>
  );
}
