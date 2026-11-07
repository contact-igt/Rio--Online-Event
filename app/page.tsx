import Link from "next/link";
import { CompetitionCard } from "@/components/competition-card";
import { HeroVisual } from "@/components/hero-visual";
import { Icon } from "@/components/ui/icon";
import { InfoStrip } from "@/components/ui/info-strip";
import { SectionHeading } from "@/components/ui/section-heading";
import { Steps, type Step } from "@/components/ui/steps";
import { emailEnabled } from "@/lib/email/config";
import { AGE_MAX, AGE_MIN, awards, events, rules } from "@/lib/events";
import { loadPublicRegistration } from "@/lib/registration/public-status";

// The campaign landing page. Mobile first: a short hero with two clear actions, then the six competitions, how to take part, the rules.
// Cached for a minute so it stays fast; the only live fact on it is whether registration is open. Every number comes from lib/events.ts.
export const revalidate = 60;

const section = "mx-auto w-full max-w-[1200px] px-4 py-[clamp(2.5rem,6vw,4.5rem)] sm:px-6 lg:px-8";

const facts = [
  { icon: "users", ta: "வயது", en: "Ages", value: `${AGE_MIN} – ${AGE_MAX}` },
  { icon: "video", ta: "வீடியோ நீளம்", en: "Video length", value: `${rules.videoSeconds.min} – ${rules.videoSeconds.max} sec` },
  { icon: "laptop", ta: "முறை", en: "Mode", value: "Online" },
] as const;

const ruleList = [
  { ta: `வயது வரம்பு: ${AGE_MIN} – ${AGE_MAX} ஆண்டுகள்`, en: `Age limit: ${AGE_MIN} – ${AGE_MAX} years` },
  { ta: `வீடியோ நீளம்: ${rules.videoSeconds.min} – ${rules.videoSeconds.max} வினாடிகள்`, en: `Video length: ${rules.videoSeconds.min} – ${rules.videoSeconds.max} seconds` },
  { ta: "தெளிவான ஒலி மற்றும் காட்சி", en: "Clear audio and video" },
  { ta: "ஒரு குழந்தைக்கு ஒரு போட்டி மட்டும்", en: "One competition entry per child" },
  { ta: "பெற்றோர் ஒப்புதல் அவசியம்; பதிவைப் பகிர்வதற்கான ஒப்புதல் விருப்பமானது", en: "A parent's consent is required; permission to share the entry is optional" },
  { ta: "வீடியோவை ஆன்லைனில் சமர்ப்பிக்க வேண்டும்", en: "The video is submitted online" },
] as const;

export default async function HomePage() {
  const open = (await loadPublicRegistration()) === "open";
  // Only promise a confirmation e-mail when one will really be sent.
  const steps: Step[] = [
    { ta: "போட்டியைத் தேர்ந்தெடுங்கள்", en: "Choose a competition", icon: "trophy" },
    { ta: "பதிவு செய்யுங்கள்", en: "Register", icon: "edit" },
    { ta: "வீடியோவைப் பதிவேற்றுங்கள்", en: "Upload your video", icon: "upload" },
    emailEnabled() ? { ta: "உறுதிப்படுத்தல் மின்னஞ்சலைப் பெறுங்கள்", en: "Get a confirmation email", icon: "mail" } : { ta: "பதிவை இறுதி செய்யுங்கள்", en: "Submit your entry", icon: "check" },
  ];

  return (
    <>
      <section aria-labelledby="hero-title" className="wash relative overflow-hidden">
        <div className="relative mx-auto grid w-full max-w-[1200px] gap-8 px-4 pb-8 pt-[clamp(1.75rem,5vw,3.25rem)] sm:px-6 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] lg:items-end lg:gap-10 lg:pb-0 lg:px-8">
          <div className="lg:pb-12">
            <p lang="en" className="eyebrow rise" style={{ "--i": 0 } as React.CSSProperties}>
              <span aria-hidden="true" className="h-px w-8 bg-current" />
              Children&apos;s Day Celebration 2026
            </p>
            <h1 id="hero-title" className="rise mt-3 text-[clamp(2.75rem,10.5vw,5.5rem)] font-extrabold leading-[1.22]" style={{ "--i": 1 } as React.CSSProperties}>
              <span className="block">மழலைத்</span>{" "}
              <span className="inline-flex items-center gap-2 text-rio-rose">
                <span>தமிழே!</span>
                <svg
                  aria-hidden="true"
                  className="inline-block h-8 w-8 text-rio-rose sm:h-10 sm:w-10"
                  viewBox="0 0 32 32"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                >
                  <line x1="8" y1="16" x2="2" y2="16" />
                  <line x1="10" y1="10" x2="4" y2="4" />
                  <line x1="16" y1="8" x2="16" y2="2" />
                </svg>
              </span>
            </h1>
            <p className="rise font-display text-[clamp(1.35rem,4.2vw,2rem)] font-bold text-rio-navy mt-1" style={{ "--i": 2 } as React.CSSProperties}>
              என் மொழி… என் மகிழ்ச்சி!
            </p>
            <p className="rise mt-4 max-w-[50ch] text-[clamp(1.02rem,2.2vw,1.15rem)] leading-[1.7] text-rio-ink" style={{ "--i": 3 } as React.CSSProperties}>
              குழந்தைகள் தினத்தைக் கொண்டாட, உங்கள் குழந்தையின் திறமையை வெளிப்படுத்த ஒரு சிறப்பு வாய்ப்பு!
            </p>
            <p lang="en" className="rise mt-1.5 max-w-[50ch] text-[clamp(0.92rem,1.8vw,1.02rem)] leading-relaxed text-rio-slate" style={{ "--i": 3 } as React.CSSProperties}>
              A special Children&apos;s Day celebration to showcase your child&apos;s talent, creativity and love for Tamil.
            </p>

            <ul className="rise mt-6 grid grid-cols-3 gap-2 sm:max-w-xl sm:gap-3" style={{ "--i": 4 } as React.CSSProperties}>
              {facts.map((f) => (
                <li key={f.en} className="card flex min-w-0 flex-col items-start gap-0.5 px-3 py-3 sm:px-4">
                  <Icon name={f.icon} className="h-6 w-6 text-rio-rose" />
                  <span className="text-sm font-semibold leading-tight text-rio-navy [overflow-wrap:anywhere]">{f.ta}</span>
                  <span lang="en" className="text-xs leading-tight text-rio-slate">
                    {f.en}
                  </span>
                  <span lang="en" className="font-display text-lg sm:text-xl font-bold leading-tight text-rio-navy tabular-nums">
                    {f.value}
                  </span>
                </li>
              ))}
            </ul>

            <div className="rise mt-7 flex flex-col gap-3 sm:flex-row" style={{ "--i": 5 } as React.CSSProperties}>
              <Link href="/competitions" className="btn btn-primary min-h-14 flex-col !gap-0 px-8 text-lg sm:flex-1 sm:max-w-72">
                <span>இப்போதே பதிவு செய்யுங்கள்</span>
                <span lang="en" className="flex items-center gap-2 text-base font-semibold">
                  Register Now <Icon name="arrow" className="h-4 w-4" />
                </span>
              </Link>
              <Link href="/competitions" className="btn btn-outline min-h-14 flex-col !gap-0 px-8 text-lg sm:flex-1 sm:max-w-72">
                <span>போட்டிகளைப் பாருங்கள்</span>
                <span lang="en" className="flex items-center gap-2 text-base font-semibold">
                  Explore Competitions <Icon name="arrow" className="h-4 w-4" />
                </span>
              </Link>
            </div>
            <p className="rise mt-4 font-semibold text-rio-navy" style={{ "--i": 6 } as React.CSSProperties}>
              {open ? (
                <>
                  பதிவு திறந்துள்ளது <span lang="en" className="font-medium text-rio-slate">/ Registration is open</span>
                </>
              ) : (
                <>
                  பதிவு விரைவில் தொடங்கும் <span lang="en" className="font-medium text-rio-slate">/ Registration opens soon</span>
                </>
              )}
            </p>
          </div>

          <div className="rise flex items-end justify-center self-end lg:justify-end" style={{ "--i": 4 } as React.CSSProperties}>
            <HeroVisual size="hero" />
          </div>
        </div>
      </section>

      <div className="mx-auto -mt-2 w-full max-w-[1200px] px-4 sm:px-6 lg:px-8">
        <InfoStrip
          label="Event facts"
          items={[
            { icon: "calendar", ta: "குழந்தைகள் தினச் சிறப்பு நிகழ்வு", en: "Children's Day Special Event" },
            { icon: "users", ta: `${events.length} போட்டிகள்`, en: `${events.length} Competitions` },
            { icon: "trophy", ta: `${AGE_MIN}–${AGE_MAX} வயதினருக்குத் திறந்தது`, en: `Open for ages ${AGE_MIN}–${AGE_MAX}` },
            { icon: "laptop", ta: "ஆன்லைன் பங்கேற்பு", en: "Online participation" },
          ]}
        />
      </div>

      <section id="competitions" aria-labelledby="competitions-title" className={section}>
        <SectionHeading id="competitions-title" eyebrow="Six competitions" ta="ஆறு போட்டிகள்" en="Six Competitions" subTa="உங்கள் குழந்தையின் ஆர்வத்துக்கேற்ற போட்டியைத் தேர்வு செய்யுங்கள்." subEn="Pick your child's interest and take part in one of our six competitions. A child can enter one competition only." />
        <ol className="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {events.map((e, i) => (
            <CompetitionCard key={e.slug} event={e} index={i} />
          ))}
        </ol>
        <p className="mt-8 text-center">
          <Link href="/competitions" className="btn btn-outline min-h-12 px-8">
            <span>
              அனைத்துப் போட்டிகள் <span lang="en" className="font-semibold">/ All competitions and age filter</span>
            </span>
            <Icon name="arrow" className="h-4 w-4" />
          </Link>
        </p>
      </section>

      <section id="how" aria-labelledby="how-title" className="bg-white/70">
        <div className={section}>
          <SectionHeading id="how-title" eyebrow="Simple process" ta="பங்கேற்பது எப்படி?" en="How It Works?" />
          <Steps steps={steps} label="Steps to take part" />
        </div>
      </section>

      <section id="rules" aria-labelledby="rules-title" className={section}>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="on-navy rounded-[1.75rem] bg-rio-navy p-6 text-white sm:p-8">
            <h2 id="rules-title" className="!text-white text-[clamp(1.5rem,4vw,2.1rem)] font-extrabold">
              விதிகள் <span lang="en">· Rules at a Glance</span>
            </h2>
            <ul className="mt-5 space-y-3">
              {ruleList.map((r) => (
                <li key={r.en} className="flex min-w-0 gap-3">
                  <span aria-hidden="true" className="mt-1 grid size-6 shrink-0 place-items-center rounded-full bg-rio-pink-soft text-rio-navy">
                    <Icon name="check" className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 leading-snug [overflow-wrap:anywhere]">
                    {r.ta}
                    <span lang="en" className="block text-sm text-white/90">
                      {r.en}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="card-soft p-6 sm:p-8">
            <h2 className="text-[clamp(1.5rem,4vw,2.1rem)] font-extrabold">
              பரிசுகள் <span lang="en">· Prizes and Awards</span>
            </h2>
            <p className="mt-3">சிறந்த பங்கேற்பாளர்களுக்குப் பரிசுகளும் சான்றிதழ்களும் வழங்கப்படும். விவரங்கள் பின்னர் உறுதிசெய்யப்படும்.</p>
            <p lang="en" className="text-rio-slate">
              Prizes and certificates for the best entries. Details will be confirmed later.
            </p>
            <div className="mt-5 rounded-2xl bg-white p-4">
              <p lang="en" className="inline-block rounded-full bg-rio-rose px-4 py-1 text-sm font-bold text-white">
                Award categories
              </p>
              <ul lang="en" className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {awards.map((a) => (
                  <li key={a} className="flex items-center gap-2 font-semibold text-rio-navy">
                    <Icon name="star" className="h-5 w-5 text-rio-rose" />
                    {a}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="cta-title" className="mx-auto w-full max-w-[1200px] px-4 pb-4 sm:px-6 lg:px-8">
        <div className="on-navy relative overflow-hidden rounded-[1.75rem] bg-rio-navy p-6 text-white sm:p-10">
          <div aria-hidden="true" className="absolute -right-16 -top-16 size-64 rounded-full bg-rio-pink/20" />
          <div className="relative">
            <h2 id="cta-title" className="!text-white text-[clamp(1.6rem,4.5vw,2.4rem)] font-extrabold">
              உங்கள் குழந்தையை இன்றே பதிவு செய்யுங்கள்! <span lang="en">· Register your child today!</span>
            </h2>
            <p className="mt-2 max-w-[60ch] text-white/90">உங்கள் குழந்தையின் திறமையை உலகுடன் பகிருங்கள்.</p>
            <p lang="en" className="max-w-[60ch] text-sm text-white/90">
              Share your child&apos;s talent with everyone.
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <Link href="/competitions" className="btn btn-primary min-h-12 px-8">
                <span>
                  பதிவு செய்யுங்கள் <span lang="en" className="font-semibold">/ Register Now</span>
                </span>
                <Icon name="arrow" className="h-4 w-4" />
              </Link>
              <Link href="/competitions" className="btn btn-light min-h-12 px-8">
                <span>
                  போட்டிகளைப் பாருங்கள் <span lang="en" className="font-semibold">/ Explore Competitions</span>
                </span>
                <Icon name="arrow" className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
