import type { Metadata } from "next";
import { Anek_Tamil } from "next/font/google";
import { notFound } from "next/navigation";
import { events } from "@/lib/events";
import { reg } from "@/lib/registration/messages";

export const metadata: Metadata = { title: "Tamil typography comparison (development)", robots: { index: false } };

// DEVELOPMENT ONLY (a 404 in production, like everything under /dev). It loads its own full set of Anek Tamil weights so the comparison is fair;
// the public site loads a single weight (see app/layout.tsx), and these extra files exist only on this page. Real strings from lib/events.ts and
// lib/registration/messages.ts; nothing is saved or sent.
const anek = Anek_Tamil({ subsets: ["tamil"], weight: ["400", "500", "600", "700", "800"], variable: "--font-anek-lab", display: "swap" });

type Face = { name: string; stack: string; note: string; body: number; label: number };
const faces: Face[] = [
  { name: "Anek Tamil", stack: "var(--font-anek-lab)", note: "Tamil letters only; English below stays as on the site", body: 400, label: 600 },
  { name: "Baloo Thambi 2", stack: "var(--font-baloo)", note: "lightest loaded weight is 600", body: 600, label: 700 },
  { name: "Hind Madurai", stack: "var(--font-hind)", note: "body and form font today", body: 400, label: 600 },
];

// English never changes: headings keep Baloo, body text keeps Hind, whatever font is being compared for Tamil.
const En = ({ children, role }: { children: React.ReactNode; role: "heading" | "body" }) => (
  <span lang="en" style={{ fontFamily: role === "heading" ? "var(--font-baloo)" : "var(--font-hind)" }}>
    {children}
  </span>
);

function Row({ title, note, render }: { title: string; note: string; render: (f: Face) => React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-2xl font-bold">{title}</h2>
      <p lang="en" className="text-rio-slate">{note}</p>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {faces.map((f) => (
          <div key={f.name} className="card min-w-0 p-5" style={{ fontFamily: f.stack }}>
            <p lang="en" className="mb-3 text-sm font-bold text-rio-rose" style={{ fontFamily: "var(--font-hind)" }}>
              {f.name} <span className="font-normal text-rio-slate">({f.note})</span>
            </p>
            {render(f)}
          </div>
        ))}
      </div>
    </section>
  );
}

export default function TypographyPage() {
  if (process.env.NODE_ENV === "production") notFound();
  const ev = events[3]!;
  const f = reg.form;
  return (
    <div className={`${anek.variable} mx-auto w-full max-w-[1200px] px-4 py-[clamp(1.5rem,5vw,3rem)] sm:px-6 lg:px-8`}>
      <p role="note" className="rounded-2xl border border-amber-300 bg-amber-50 p-4 font-semibold text-rio-navy">
        Development comparison of Tamil fonts. This page does not exist in production.
      </p>
      <h1 className="mt-6 text-[clamp(1.75rem,5vw,2.5rem)] font-bold">Tamil typography: Anek Tamil, Baloo Thambi 2, Hind Madurai</h1>

      <Row
        title="Landing page headline"
        note="The real hero text at 800 and the tagline at 700, then the intro line."
        render={(face) => (
          <>
            <p className="text-[clamp(2.25rem,5vw,3.5rem)] leading-[1.22]" style={{ fontWeight: 800, color: "var(--rio-navy)" }}>
              மழலைத் <span style={{ color: "var(--rio-rose)" }}>தமிழே!</span>
            </p>
            <p className="mt-1 text-xl" style={{ fontWeight: 700, color: "var(--rio-navy)" }}>என் மொழி… என் மகிழ்ச்சி!</p>
            <p className="mt-3" style={{ fontWeight: face.body }}>
              குழந்தைகள் தினத்தைக் கொண்டாட, உங்கள் குழந்தையின் திறமையை வெளிப்படுத்த ஒரு சிறப்பு வாய்ப்பு!
            </p>
          </>
        )}
      />

      <Row
        title="Competition card"
        note="Heading at 700, task line in the body weight."
        render={(face) => (
          <>
            <p className="text-[1.35rem] leading-snug" style={{ fontWeight: 700, color: "var(--rio-navy)" }}>{ev.nameTa}</p>
            <p className="text-lg" style={{ fontWeight: 600, color: "var(--rio-navy)" }}><En role="heading">{ev.nameEn}</En></p>
            <p className="chip mt-3 inline-flex" style={{ fontWeight: face.label }}>
              வயது / <En role="body">Age:</En> {ev.minAge}–{ev.maxAge} ஆண்டுகள் / <En role="body">years</En>
            </p>
            <p className="mt-3" style={{ fontWeight: face.body }}>{ev.taskTa}</p>
            <p className="text-rio-slate" style={{ fontWeight: 400 }}><En role="body">{ev.taskEn}</En></p>
          </>
        )}
      />

      <Row
        title="Registration labels"
        note="Section bar at 700, labels at the label weight, helper text in the body weight."
        render={(face) => (
          <>
            <p className="flex items-center gap-3 rounded-xl bg-rio-mist px-4 py-2.5 text-lg" style={{ fontWeight: 700, color: "var(--rio-navy)" }}>
              <span>{f.childSection.ta} / <En role="heading">{f.childSection.en}</En></span>
            </p>
            <p className="mt-4" style={{ fontWeight: face.label, color: "var(--rio-navy)" }}>
              {f.childName.ta} / <En role="body">{f.childName.en}</En>
              <span className="ml-2 inline-block rounded-full bg-rio-blush px-2 py-0.5 align-middle text-xs" style={{ fontWeight: 700, color: "var(--rio-rose)" }}>
                <En role="body">{f.required.en}</En> / {f.required.ta}
              </span>
            </p>
            <p className="mt-4" style={{ fontWeight: face.label, color: "var(--rio-navy)" }}>
              {f.mobile.ta} / <En role="body">{f.mobile.en}</En>
            </p>
            <p className="mt-4 text-sm text-rio-slate" style={{ fontWeight: face.body }}>{f.requiredNote.ta}</p>
          </>
        )}
      />

      <section className="mt-12 border-t border-rio-navy/15 pt-8">
        <h2 className="text-2xl font-bold">Recommended pairing, as the site renders it</h2>
        <p lang="en" className="text-rio-slate">Hero in Baloo Thambi 2, section headings (the real h2/h3 styles) in Anek Tamil, body and form text in Hind Madurai.</p>
        <div className="card mt-4 p-5 sm:p-8">
          <p className="font-display text-[clamp(2.75rem,8vw,4.5rem)] font-extrabold leading-[1.22] text-rio-navy">
            மழலைத் <span className="text-rio-rose">தமிழே!</span>
          </p>
          <h3 className="mt-6 text-[1.35rem] font-bold leading-snug">{ev.nameTa}</h3>
          <p lang="en" className="font-display text-lg font-semibold text-rio-navy">{ev.nameEn}</p>
          <p className="mt-2">{ev.taskTa}</p>
          <p lang="en" className="text-rio-slate">{ev.taskEn}</p>
          <h3 className="mt-6 flex items-center gap-3 rounded-xl bg-rio-mist px-4 py-2.5 text-lg font-bold">
            <span>{f.childSection.ta} <span lang="en">/ {f.childSection.en}</span></span>
          </h3>
          <p className="mt-4 font-semibold text-rio-navy">{f.childName.ta} <span lang="en">/ {f.childName.en}</span></p>
        </div>
      </section>
    </div>
  );
}
