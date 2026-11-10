import { AGES } from "@/lib/events";

type Props = {
  min: number;
  max: number;
  /** Age picked in the age finder; shown in the accent colour when it falls inside the band. */
  highlight?: number | null;
  large?: boolean;
};

// Ages 3-12 as a strip. Filled cells are the ages the competition accepts, so overlaps between
// competitions are visible at a glance.
export function AgeRuler({ min, max, highlight = null, large = false }: Props) {
  return (
    <div role="img" aria-label={`Ages ${min} to ${max}`} className="flex gap-1">
      {AGES.map((age) => {
        const inBand = age >= min && age <= max;
        const picked = inBand && highlight === age;
        const tone = picked
          ? "bg-rio-rose text-white ring-2 ring-rio-navy"
          : inBand
            ? "bg-rio-navy text-white"
            : "border border-rio-slate/30 text-rio-slate";
        return (
          <span
            key={age}
            aria-hidden="true"
            className={`grid flex-1 place-items-center rounded-md text-sm font-semibold tabular-nums ${large ? "h-10" : "h-7"} ${tone}`}
          >
            {age}
          </span>
        );
      })}
    </div>
  );
}
