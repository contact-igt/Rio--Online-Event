import type { Metadata } from "next";
import Link from "next/link";
import { SetPasswordForm } from "@/components/staff/set-password-form";
import { mustChangePassword, staffRole } from "@/lib/staff/auth";
import { staffLoginPath } from "@/lib/staff/paths";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Set a password · கடவுச்சொல்", robots: { index: false } };
export const dynamic = "force-dynamic";

const TOKEN = /^[A-Za-z0-9_-]{8,200}$/;

// The page an invitation e-mail links to: /staff/set-password?token_hash=...&type=invite. Opening the page does NOT use up the token (an
// e-mail scanner may open links); the token is checked when the form is sent. Without a token the page works only for a staff member who is
// already signed in.
export default async function SetPasswordPage({ searchParams }: { searchParams: Promise<{ token_hash?: string; type?: string }> }) {
  const q = await searchParams;
  const tokenHash = typeof q.token_hash === "string" && TOKEN.test(q.token_hash) ? q.token_hash : null;
  const type = q.type === "invite" || q.type === "recovery" ? q.type : null;

  let allowed = tokenHash !== null && type !== null;
  let forced = false;
  if (!allowed) {
    try {
      const supabase = await createClient();
      const { data } = await supabase.auth.getUser();
      allowed = data.user ? (await staffRole(supabase, data.user.id)) !== null : false;
      forced = allowed && data.user !== null && mustChangePassword(data.user);
    } catch {
      allowed = false;
    }
  }

  return (
    <section className="mx-auto w-full max-w-[1200px] px-4 py-[clamp(2rem,6vw,4rem)] sm:px-6 lg:px-8">
      <div className="mx-auto max-w-md">
        <h1 className="text-[clamp(1.75rem,6vw,2.5rem)] font-extrabold">
          Set your password <span lang="ta" className="block text-[0.6em] font-bold text-rio-slate">கடவுச்சொல்லை அமைக்கவும்</span>
        </h1>
        {forced && (
          <p role="status" className="mt-4 rounded-2xl bg-rio-mist p-4 font-semibold text-rio-navy">
            An administrator set a temporary password for you. Choose your own password to continue. You cannot use the staff area until you do.
          </p>
        )}
        <div className="card mt-6 p-5 sm:p-6">
          {allowed ? (
            <SetPasswordForm tokenHash={tokenHash} type={type} />
          ) : (
            <div role="alert" className="space-y-3">
              <p className="font-semibold text-rio-error">This link is not valid any more. Ask an administrator for a new invitation.</p>
              <Link href={staffLoginPath} className="btn btn-outline w-full sm:w-auto">
                Staff sign-in
              </Link>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
