import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Bilingual } from "@/components/auth/bilingual";
import { EmailForm } from "@/components/auth/email-form";
import { afterSignInPath } from "@/lib/auth/paths";
import { copy } from "@/lib/auth/messages";
import { resolveOtpLength } from "@/lib/auth/otp-length";
import { parseEventSlug } from "@/lib/auth/schemas";
import { getParent } from "@/lib/auth/session";
import { getEvent } from "@/lib/events";

export const metadata: Metadata = { title: "உள்நுழைக · Sign in", robots: { index: false } };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ event?: string; expired?: string }> }) {
  const params = await searchParams;
  const event = parseEventSlug(params.event);

  let user = null;
  let unavailable = false;
  try {
    user = await getParent();
  } catch {
    unavailable = true; // Supabase is not configured for this environment
  }
  if (user) redirect(afterSignInPath(event)); // a returning parent keeps their session
  let length = 6;
  try {
    length = resolveOtpLength();
  } catch {
    unavailable = true; // misconfigured code length: no form, because no code could be accepted
  }

  const selected = event ? getEvent(event) : undefined;

  return (
    <section className="mx-auto w-full max-w-[1200px] px-4 py-[clamp(2rem,6vw,4rem)] sm:px-6 lg:px-8">
      <div className="max-w-xl">
        <h1 className="text-[clamp(2rem,6vw,3rem)] font-extrabold">
          {copy.signIn.title.ta} <span lang="en" className="block text-rio-slate">{copy.signIn.title.en}</span>
        </h1>
        <p className="mt-3 text-lg">
          <Bilingual m={copy.signIn.lead(length)} />
        </p>
        {params.expired === "1" && (
          <p role="status" className="mt-4 rounded-xl bg-white px-4 py-3 font-semibold text-rio-navy">
            <Bilingual m={copy.signIn.expired} />
          </p>
        )}
        {selected && (
          <p className="mt-4 rounded-xl bg-white px-4 py-3 font-semibold text-rio-navy">
            {copy.signIn.selected.ta}: {selected.nameTa}
            <span lang="en" className="block font-medium text-rio-slate">
              {copy.signIn.selected.en}: {selected.nameEn}
            </span>
          </p>
        )}
        <div className="mt-6 card p-5 sm:p-6">
          {unavailable ? (
            <p role="alert" className="font-semibold text-rio-error">
              <Bilingual m={copy.errors.unavailable} />
            </p>
          ) : (
            <EmailForm event={event} />
          )}
        </div>
      </div>
    </section>
  );
}
