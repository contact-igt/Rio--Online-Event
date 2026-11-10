import type { Metadata } from "next";
import { CompetitionBrowser } from "@/components/competition-browser";
import { HeroVisual } from "@/components/hero-visual";
import { Icon, type IconName } from "@/components/ui/icon";
import { InfoStrip } from "@/components/ui/info-strip";
import { SectionHeading } from "@/components/ui/section-heading";
import { Steps, type Step } from "@/components/ui/steps";
import { emailEnabled } from "@/lib/email/config";
import { AGE_MAX, AGE_MIN, rules } from "@/lib/events";
import { loadPublicRegistration } from "@/lib/registration/public-status";

export const revalidate = 60; // the only live fact here is whether registration is open

export const metadata: Metadata = {
  title: "போட்டிகள் · Competitions",
  description: `Choose a competition for your child (ages ${AGE_MIN} to ${AGE_MAX}). Six online Tamil video competitions from Rio Hospital for Women & Children.`,
};

const stages: { ta: string; en: string; icon: IconName }[] = [
  { ta: "போட்டி தேர்வு", en: "1. Competition selection", icon: "trophy" },
  { ta: "பதிவு", en: "2. Registration", icon: "users" },
  { ta: "வீடியோ பதிவேற்றம்", en: "3. Upload video", icon: "upload" },
  { ta: "பதிவை இறுதி செய்தல்", en: "4. Submit entry", icon: "check" },
];

export default async function CompetitionsPage() {
  const open = (await loadPublicRegistration()) === "open";
  const next: Step[] = [
    { ta: "போட்டியைத் தேர்ந்தெடுங்கள்", en: "Select a competition", icon: "trophy" },
    { ta: "பதிவுப் படிவத்தை நிரப்புங்கள்", en: "Fill in the registration form", icon: "edit" },
    { ta: "வீடியோவைப் பதிவேற்றுங்கள்", en: "Upload your video", icon: "upload" },
    emailEnabled() ? { ta: "உறுதிப்படுத்தல் மின்னஞ்சலைப் பெறுங்கள்", en: "Get a confirmation email", icon: "mail" } : { ta: "பதிவை இறுதி செய்யுங்கள்", en: "Submit your entry", icon: "check" },
  ];

  return (
    <>
      <section aria-labelledby="choose-title" className="wash">
        <div className="mx-auto w-full max-w-[1200px] px-4 pb-8 pt-[clamp(1.75rem,5vw,3.25rem)] sm:px-6 lg:px-8">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-end lg:gap-10">
            <div className="lg:pb-4">
              <p lang="en" className="eyebrow">
                <span aria-hidden="true" className="h-px w-8 bg-current" />
                Children&apos;s Day Celebration 2026
              </p>
              <h1 id="choose-title" className="mt-3 text-[clamp(2.35rem,8vw,3.85rem)] font-extrabold leading-[1.26]">
                <span className="block">போட்டியைத்</span>{" "}
                <span className="block text-rio-rose">தேர்வு செய்யுங்கள்!</span>
              </h1>
              <p lang="en" className="font-display text-[clamp(1.35rem,3.8vw,1.9rem)] font-bold text-rio-navy mt-1">
                Choose a Competition!
              </p>
              <p className="mt-3.5 max-w-[54ch] text-[clamp(1.02rem,2.2vw,1.15rem)] leading-[1.7] text-rio-ink">
                உங்கள் குழந்தையின் திறமைக்கு ஏற்ற போட்டியைத் தேர்ந்தெடுத்து, பதிவு செய்து, வீடியோவைப் பதிவேற்றுங்கள்.
              </p>
              <p lang="en" className="mt-1 max-w-[54ch] text-[clamp(0.92rem,1.8vw,1.02rem)] leading-relaxed text-rio-slate">
                Pick a competition that matches your child&apos;s talent, register, and upload the video.
              </p>
            </div>
            <div className="hidden lg:flex lg:items-end lg:justify-end self-end">
              <HeroVisual size="competitions" />
            </div>
          </div>

          <ol aria-label="Four steps to take part" className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {stages.map((s, i) => (
              <li key={s.en} aria-current={i === 0 ? "step" : undefined} className={`flex min-w-0 items-center gap-3 rounded-full px-4 py-2.5 ${i === 0 ? "bg-rio-rose text-white shadow-[0_12px_22px_-14px_rgb(212_32_107/0.8)]" : "card !rounded-full text-rio-navy"}`}>
                <Icon name={s.icon} className={`h-6 w-6 ${i === 0 ? "" : "text-rio-rose"}`} />
                <span className="min-w-0 text-sm font-bold leading-tight">
                  <span className="block [overflow-wrap:anywhere]">{s.ta}</span>
                  <span lang="en" className={`block font-semibold ${i === 0 ? "" : "text-rio-slate"}`}>
                    {s.en}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 sm:px-6 lg:px-8">
        <InfoStrip
          label="Competition facts"
          items={[
            { icon: "video", ta: `வீடியோ நீளம்: ${rules.videoSeconds.min}–${rules.videoSeconds.max} வினாடிகள்`, en: `Video length: ${rules.videoSeconds.min}–${rules.videoSeconds.max} sec` },
            { icon: "laptop", ta: "ஆன்லைன் சமர்ப்பிப்பு", en: "Online submission" },
            { icon: "users", ta: `${AGE_MIN}–${AGE_MAX} வயது`, en: `Ages ${AGE_MIN}–${AGE_MAX}` },
            { icon: "check", ta: "ஒரு குழந்தைக்கு ஒரு போட்டி", en: "One competition per child" },
          ]}
        />
      </div>

      <section aria-labelledby="filter-title" className="mx-auto w-full max-w-[1200px] px-4 py-[clamp(2.5rem,6vw,4rem)] sm:px-6 lg:px-8">
        <SectionHeading id="filter-title" eyebrow="Choose by age" ta="வயது வடிகட்டி" en="Filter by Age" subTa="உங்கள் குழந்தையின் வயதைத் தேர்ந்தெடுத்தால் தகுதியான போட்டிகள் தெரியும்." subEn="Select your child's age to see which competitions they can enter." />
        <div className="mt-8">
          <CompetitionBrowser open={open} />
        </div>
      </section>

      <section aria-labelledby="next-title" className="bg-white/70">
        <div className="mx-auto w-full max-w-[1200px] px-4 py-[clamp(2.5rem,6vw,4rem)] sm:px-6 lg:px-8">
          <SectionHeading id="next-title" eyebrow="Next steps" ta="அடுத்தது என்ன?" en="How It Works Next?" />
          <Steps steps={next} label="What happens next" />
        </div>
      </section>
    </>
  );
}
