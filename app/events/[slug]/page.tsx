import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AgeRuler } from "@/components/age-ruler";
import { RegisterCall } from "@/components/register-call";
import { SpeakerVisual } from "@/components/speaker-visual";
import { Icon, eventIcon } from "@/components/ui/icon";
import { loadPublicRegistration } from "@/lib/registration/public-status";
import { ageRangeEn, events, getEvent, rules, sharedAges, winnersLine } from "@/lib/events";

type Params = Promise<{ slug: string }>;

export const dynamicParams = false;
export const revalidate = 60; // the only live fact on this page is whether registration is open

export function generateStaticParams() {
  return events.map((e) => ({ slug: e.slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const event = getEvent(slug);
  if (!event) return {};
  return {
    title: `${event.nameTa} · ${event.nameEn}`,
    description: `${event.nameEn}: ages ${event.minAge}–${event.maxAge}. ${event.taskEn}`,
  };
}

export default async function EventPage({ params }: { params: Params }) {
  const { slug } = await params;
  const event = getEvent(slug);
  if (!event) notFound();

  const open = (await loadPublicRegistration()) === "open";
  const index = events.indexOf(event);
  const prev = events[index - 1];
  const next = events[index + 1];
  const winners = winnersLine();
  const overlaps = events
    .filter((other) => other.slug !== event.slug)
    .flatMap((other) => {
      const shared = sharedAges(event, other);
      return shared ? [{ other, shared }] : [];
    });

  const details = [
    { icon: "users", ta: "வயது", en: "Age band", value: `${event.minAge}–${event.maxAge}` },
    { icon: "video", ta: "வீடியோ நீளம்", en: "Video length", value: `${rules.videoSeconds.min}–${rules.videoSeconds.max} sec` },
    { icon: "laptop", ta: "முறை", en: "Mode", value: "Online" },
  ] as const;

  return (
    <article>
      <section className="wash">
        <div className="mx-auto flex w-full max-w-[1200px] flex-col justify-between gap-6 px-4 pb-8 pt-[clamp(1.25rem,4vw,2.5rem)] sm:px-6 lg:flex-row lg:items-center lg:px-8">
          <div className="min-w-0 flex-1">
            <Link href="/competitions" className="inline-flex min-h-11 flex-wrap items-center gap-x-2 font-semibold text-rio-blue underline underline-offset-4">
              <span>← அனைத்துப் போட்டிகள்</span>
              <span lang="en">/ All competitions</span>
            </Link>

            <p lang="en" className="eyebrow mt-3">
              <span aria-hidden="true" className="h-px w-8 bg-current" />
              Competition {event.number} of {events.length}
            </p>
            <div className="mt-3 flex items-start gap-4">
              <span aria-hidden="true" className="hidden size-20 shrink-0 place-items-center rounded-3xl bg-white text-rio-rose shadow-[0_16px_28px_-20px_rgb(212_32_107/0.6)] sm:grid">
                <Icon name={eventIcon[event.slug] ?? "star"} className="h-11 w-11" />
              </span>
              <div className="min-w-0">
                <h1 className="text-[clamp(2.25rem,8vw,4.25rem)] font-extrabold [overflow-wrap:anywhere]">{event.nameTa}</h1>
                <p lang="en" className="font-display text-[clamp(1.35rem,4vw,2rem)] font-bold text-rio-rose">
                  {event.nameEn}
                </p>
              </div>
            </div>

            <ul className="mt-6 grid max-w-xl grid-cols-3 gap-2 sm:gap-3">
              {details.map((d) => (
                <li key={d.en} className="card flex min-w-0 flex-col gap-0.5 px-3 py-3">
                  <Icon name={d.icon} className="h-6 w-6 text-rio-rose" />
                  <span className="text-sm font-semibold leading-tight text-rio-navy">{d.ta}</span>
                  <span lang="en" className="text-xs leading-tight text-rio-slate">
                    {d.en}
                  </span>
                  <span lang="en" className="font-display text-lg font-bold leading-tight text-rio-navy tabular-nums">
                    {d.value}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {event.slug === "kutti-pesalar" && (
            <div className="hidden shrink-0 lg:block">
              <SpeakerVisual />
            </div>
          )}
        </div>
      </section>

      <div className="mx-auto grid w-full max-w-[1200px] gap-8 px-4 py-[clamp(1.75rem,5vw,3.5rem)] sm:px-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-12 lg:px-8">
        <div className="space-y-6">
          <section className="card p-5 sm:p-6">
            <h2 className="text-2xl font-bold">
              என்ன செய்ய வேண்டும்? <span lang="en" className="text-rio-slate">· The task</span>
            </h2>
            <p className="mt-2 max-w-[60ch] text-xl">{event.taskTa}</p>
            <p lang="en" className="max-w-[60ch] text-lg text-rio-slate">
              {event.taskEn}
            </p>
          </section>

          <section className="card-soft p-5 sm:p-6">
            <h2 className="text-2xl font-bold">
              வயது வரம்பு <span lang="en" className="text-rio-slate">· Eligible ages</span>
            </h2>
            <div className="mt-3">
              <AgeRuler min={event.minAge} max={event.maxAge} large />
            </div>
            <p lang="en" className="mt-2 text-rio-slate">
              For children aged {event.minAge} to {event.maxAge}. Each child can enter one competition only.
            </p>
          </section>

          <div className="flex flex-col items-start gap-3">
            <RegisterCall slug={event.slug} open={open} />
            <p className="font-semibold text-rio-navy">
              {winners.ta} <span lang="en" className="font-medium text-rio-slate">/ {winners.en}</span>
            </p>
          </div>
        </div>

        <aside className="space-y-6">
          <div className="card p-5">
            <h2 className="text-xl font-bold">
              இதே வயதுள்ள மற்ற போட்டிகள் <span lang="en" className="block text-base text-rio-slate">Other competitions that share ages</span>
            </h2>
            {overlaps.length === 0 ? (
              <p lang="en" className="mt-2 text-rio-slate">None. This is the only competition for these ages.</p>
            ) : (
              <ul className="mt-3 space-y-1">
                {overlaps.map(({ other, shared }) => (
                  <li key={other.slug}>
                    <Link href={`/events/${other.slug}`} className="inline-flex min-h-11 flex-col justify-center font-semibold text-rio-blue underline underline-offset-4">
                      {other.nameTa}
                      <span lang="en" className="text-sm font-medium text-rio-slate no-underline">
                        {other.nameEn} · shared {ageRangeEn(shared.min, shared.max)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      <nav aria-label="Competitions" className="mx-auto flex w-full max-w-[1200px] flex-wrap justify-between gap-4 px-4 pb-8 sm:px-6 lg:px-8">
        {prev ? (
          <Link href={`/events/${prev.slug}`} className="btn btn-outline min-h-11 !py-1">
            ← {prev.nameTa}
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link href={`/events/${next.slug}`} className="btn btn-outline min-h-11 !py-1">
            {next.nameTa} →
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </article>
  );
}
