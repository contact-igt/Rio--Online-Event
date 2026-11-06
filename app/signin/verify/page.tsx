import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Bilingual } from "@/components/auth/bilingual";
import { OtpForm } from "@/components/auth/otp-form";
import { maskEmail } from "@/lib/auth/email";
import { copy } from "@/lib/auth/messages";
import { resolveOtpLength } from "@/lib/auth/otp-length";
import { signInPath } from "@/lib/auth/paths";
import { readPending } from "@/lib/auth/pending";
import { parseEventSlug } from "@/lib/auth/schemas";

export const metadata: Metadata = { title: "குறியீடு · Enter your code", robots: { index: false } };

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ event?: string; resent?: string }> }) {
  const params = await searchParams;
  const event = parseEventSlug(params.event);
  const pending = await readPending();
  if (!pending) redirect(signInPath(event)); // nothing to verify: start again
  let length: number | null = null;
  try {
    length = resolveOtpLength();
  } catch {
    // misconfigured code length: show 'unavailable' instead of a form that could never succeed
  }

  return (
    <section className="mx-auto w-full max-w-[1200px] px-4 py-[clamp(2rem,6vw,4rem)] sm:px-6 lg:px-8">
      <div className="max-w-xl">
        <h1 className="text-[clamp(2rem,6vw,3rem)] font-extrabold">
          {copy.verify.title.ta} <span lang="en" className="block text-rio-slate">{copy.verify.title.en}</span>
        </h1>
        <p className="mt-3 text-lg">
          {copy.verify.sentTo.ta}: <strong>{maskEmail(pending.email)}</strong>
          <span lang="en" className="block text-rio-slate">
            {copy.verify.sentTo.en}: {maskEmail(pending.email)}
          </span>
        </p>
        {params.resent === "1" && (
          <p role="status" className="mt-3 font-semibold text-rio-ok">
            <Bilingual m={copy.verify.sentAgain} />
          </p>
        )}
        <div className="mt-6 card p-5 sm:p-6">
          {length === null ? (
            <p role="alert" className="font-semibold text-rio-error">
              <Bilingual m={copy.errors.unavailable} />
            </p>
          ) : (
            <OtpForm event={event} sentAt={pending.sentAt} length={length} />
          )}
        </div>
        <p className="mt-5 text-rio-slate">
          <Bilingual m={copy.verify.hint} />
        </p>
        <Link href={signInPath(event)} className="mt-4 inline-flex min-h-11 items-center font-semibold text-rio-blue underline underline-offset-4">
          {copy.verify.differentEmail.ta} <span lang="en">&nbsp;/ {copy.verify.differentEmail.en}</span>
        </Link>
      </div>
    </section>
  );
}
