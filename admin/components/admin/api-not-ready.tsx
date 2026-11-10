import Link from "next/link";
import { Icon } from "@/components/ui/icon";

// Shown where a screen needs data the Express API does not provide yet. It says so plainly and shows nothing invented.
export function ApiNotReady({ title, titleTa, back = "/admin" }: { title: string; titleTa?: string; back?: string }) {
  return (
    <section className="mx-auto w-full max-w-[1200px] px-4 py-[clamp(1.5rem,5vw,3rem)] sm:px-6 lg:px-8">
      <h1 className="text-[clamp(1.75rem,5vw,2.75rem)] font-extrabold">
        {title}
        {titleTa && <span lang="ta" className="block text-[0.6em] font-bold text-rio-slate">{titleTa}</span>}
      </h1>
      <p role="status" className="mt-4 flex max-w-3xl items-start gap-3 rounded-2xl bg-rio-mist p-4 font-semibold text-rio-navy">
        <Icon name="info" className="mt-0.5 h-6 w-6 shrink-0" />
        <span>
          Not available yet. This screen needs data from the new server, which has not been built. Nothing is shown here until it is.
          <span lang="ta" className="mt-1 block font-medium">இந்தத் திரைக்கான தரவு இன்னும் தயாராகவில்லை.</span>
        </span>
      </p>
      <Link href={back} className="btn btn-outline mt-6 w-full sm:w-auto">
        Back / திரும்பு
      </Link>
    </section>
  );
}
