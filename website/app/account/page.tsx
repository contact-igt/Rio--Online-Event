import type { Metadata } from "next";
import Link from "next/link";
import { signOut } from "@/app/signin/actions";
import { SubmitButton } from "@/components/auth/submit-button";
import { copy } from "@/lib/auth/messages";
import { adminUrl } from "@/lib/admin-url";
import { requireParent } from "@/lib/auth/session";
import { staffRole } from "@/lib/staff/auth";
import { staff } from "@/lib/staff/messages";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "கணக்கு · Account", robots: { index: false } };

export default async function AccountPage() {
  const user = await requireParent(null);
  const role = await staffRole(await createClient(), user.id); // staff see a link to their own area; everyone else sees nothing extra

  return (
    <section className="mx-auto w-full max-w-[1200px] px-4 py-[clamp(2rem,6vw,4rem)] sm:px-6 lg:px-8">
      <div className="max-w-xl">
        <h1 className="text-[clamp(2rem,6vw,3rem)] font-extrabold">
          {copy.account.title.ta} <span lang="en" className="block text-rio-slate">{copy.account.title.en}</span>
        </h1>
        <p className="mt-3 text-lg">
          {copy.account.as.ta}: <strong>{user.email}</strong>
          <span lang="en" className="block text-rio-slate">{copy.account.as.en}</span>
        </p>
        <div className="mt-6 flex flex-col items-start gap-4">
          <form action={signOut}>
            <SubmitButton idle={copy.account.signOut} busy={copy.account.signOut} tone="secondary" />
          </form>
          {role && (
            <Link href={adminUrl(role === "admin" ? "/admin" : "/judge")} className="btn btn-primary">
              {staff[role].title.ta} <span lang="en">&nbsp;/ {staff[role].title.en}</span>
            </Link>
          )}
          <Link href="/#competitions" className="inline-flex min-h-11 items-center font-semibold text-rio-blue underline underline-offset-4">
            {copy.account.competitions.ta} <span lang="en">&nbsp;/ {copy.account.competitions.en}</span>
          </Link>
        </div>
      </div>
    </section>
  );
}
