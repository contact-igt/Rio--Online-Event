import type { Metadata } from "next";
import Link from "next/link";
import { Bilingual } from "@/components/auth/bilingual";
import { WinnersList } from "@/components/results/winners-list";
import { results } from "@/lib/results/messages";
import { createPublicReader, loadResults, type ResultsState } from "@/lib/results/public";

export const metadata: Metadata = { title: "முடிவுகள் · Results" };

// Rendered on every request and never cached (also set as response headers in next.config.ts): a published result must appear at
// the publication time without a redeploy, and an unpublished one must never be frozen into a cached page.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function ResultsPage() {
  let state: ResultsState;
  try {
    state = await loadResults(createPublicReader());
  } catch {
    state = { kind: "unavailable" }; // missing or refused configuration: say nothing about results
  }
  return (
    <section className="mx-auto w-full max-w-[1200px] px-4 py-[clamp(2rem,6vw,4rem)] sm:px-6 lg:px-8">
      <h1 className="text-[clamp(2rem,6vw,3rem)] font-extrabold">
        <Bilingual m={results.title} />
      </h1>
      <div className="mt-6 max-w-3xl">
        <WinnersList state={state} />
      </div>
      <Link href="/" className="mt-8 inline-flex min-h-11 items-center font-semibold text-rio-blue underline underline-offset-4">
        <Bilingual m={results.back} />
      </Link>
    </section>
  );
}
