import { staffSignOut } from "@/app/staff/login/actions";
import { Icon } from "@/components/ui/icon";
import { staffSession, type StaffRole } from "@/lib/staff/auth";
import { staff } from "@/lib/staff/messages";

// A thin light-blue bar above the administrator and judge areas with the sign-out button. It renders only for a verified member of that role,
// so a signed-in parent who lands on a 404 under /admin is shown nothing that reveals the area exists.
export async function StaffBar({ role }: { role: StaffRole }) {
  if (!(await staffSession(role))) return null;
  return (
    <div className="border-b border-rio-navy/10 bg-rio-mist">
      <div className="mx-auto flex w-full max-w-[1200px] items-center justify-between gap-3 px-4 py-2 sm:px-6 lg:px-8">
        <p className="flex items-center gap-2 font-bold text-rio-navy">
          <Icon name="user" className="h-6 w-6" />
          <span>
            {role === "admin" ? "Administrator" : "Judge"} <span lang="ta" className="font-medium text-rio-slate">/ {role === "admin" ? "நிர்வாகி" : "நடுவர்"}</span>
          </span>
        </p>
        <form action={staffSignOut}>
          <button type="submit" className="btn btn-outline min-h-11 !px-4 !py-1">
            {staff.login.signOut.en} <span lang="ta" className="font-medium">/ {staff.login.signOut.ta}</span>
          </button>
        </form>
      </div>
    </div>
  );
}
