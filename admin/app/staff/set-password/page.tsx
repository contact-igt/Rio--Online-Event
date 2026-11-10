import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetPasswordForm } from "@/components/staff/set-password-form";
import { currentStaff } from "@/lib/staff/auth";
import { staffLoginPath } from "@/lib/staff/paths";

export const metadata: Metadata = { title: "Set a password · கடவுச்சொல்", robots: { index: false } };
export const dynamic = "force-dynamic";

// For the staff member who is signed in. An account whose password was set by an administrator (a new account or a reset) is sent here first
// and cannot use anything else until it has chosen its own password.
export default async function SetPasswordPage() {
  const session = await currentStaff().catch(() => null);
  if (!session) redirect(staffLoginPath);
  const forced = session.user.mustChangePassword;

  return (
    <section className="mx-auto w-full max-w-[1200px] px-4 py-[clamp(2rem,6vw,4rem)] sm:px-6 lg:px-8">
      <div className="mx-auto max-w-md">
        <h1 className="text-[clamp(1.75rem,6vw,2.5rem)] font-extrabold">
          Set your password <span lang="ta" className="block text-[0.6em] font-bold text-rio-slate">கடவுச்சொல்லை அமைக்கவும்</span>
        </h1>
        {forced && (
          <p role="status" className="mt-4 rounded-2xl bg-rio-mist p-4 font-semibold text-rio-navy">
            A temporary password was set for you. Choose your own password to continue. You cannot use the staff area until you do.
          </p>
        )}
        <div className="card mt-6 p-5 sm:p-6">
          <SetPasswordForm />
        </div>
      </div>
    </section>
  );
}
