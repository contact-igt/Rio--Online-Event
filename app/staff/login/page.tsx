import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { StaffLoginForm } from "@/components/staff/login-form";
import { staffRole } from "@/lib/staff/auth";
import { staff } from "@/lib/staff/messages";
import { staffHome } from "@/lib/staff/paths";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Staff sign-in · பணியாளர் உள்நுழைவு", robots: { index: false } };
export const dynamic = "force-dynamic";

const L = staff.login;

export default async function StaffLoginPage() {
  // a staff member who is already signed in goes straight to their own area
  let home: string | null = null;
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    const role = data.user ? await staffRole(supabase, data.user.id) : null;
    if (role) home = staffHome(role);
  } catch {
    home = null; // not configured here: the form still shows and its action will say so
  }
  if (home) redirect(home);

  return (
    <section className="mx-auto w-full max-w-[1200px] px-4 py-[clamp(2rem,6vw,4rem)] sm:px-6 lg:px-8">
      <div className="mx-auto max-w-md">
        <h1 className="text-[clamp(1.75rem,6vw,2.5rem)] font-extrabold">
          {L.title.en} <span lang="ta" className="block text-[0.6em] font-bold text-rio-slate">{L.title.ta}</span>
        </h1>
        <p className="mt-3 text-rio-slate">
          {L.intro.en}
          <span lang="ta" className="block">{L.intro.ta}</span>
        </p>
        <div className="mt-6 card p-5 sm:p-6">
          <StaffLoginForm />
        </div>
        <Link href="/signin" className="mt-6 inline-flex min-h-11 items-center font-semibold text-rio-blue underline underline-offset-4">
          {L.parents.en} <span lang="ta" className="font-medium">&nbsp;/ {L.parents.ta}</span>
        </Link>
      </div>
    </section>
  );
}
