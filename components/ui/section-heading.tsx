// A centred section title in the Rio style: small pink label, Tamil and English title on one line (wrapping on phones), a short bilingual line.
// Tamil first, English second, everywhere.

type Props = {
  id?: string;
  eyebrow: string;
  ta: string;
  en: string;
  subTa?: string;
  subEn?: string;
  onNavy?: boolean;
};

export function SectionHeading({ id, eyebrow, ta, en, subTa, subEn, onNavy = false }: Props) {
  return (
    <div className="mx-auto max-w-3xl text-center">
      <p lang="en" className={`eyebrow ${onNavy ? "!text-rio-pink-soft" : ""}`}>
        <span aria-hidden="true" className="hidden h-px w-8 bg-current sm:block" />
        {eyebrow}
        <span aria-hidden="true" className="hidden h-px w-8 bg-current sm:block" />
      </p>
      <h2 id={id} className="mt-2 text-[clamp(1.6rem,4.6vw,2.5rem)] font-extrabold">
        {ta} <span lang="en" className="text-rio-navy">· {en}</span>
      </h2>
      {subTa && <p className="mt-2 text-lg">{subTa}</p>}
      {subEn && (
        <p lang="en" className="text-rio-slate">
          {subEn}
        </p>
      )}
    </div>
  );
}
