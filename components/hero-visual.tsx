import Image from "next/image";

interface HeroVisualProps {
  size?: "hero" | "competitions";
  className?: string;
}

/**
 * Photorealistic children visual matching the approved Rio Children's Day designs (01 & 02).
 * Features two joyful Indian children with subtle playful doodles (crown, sparkles, heart)
 * integrated with a soft, diffused blush background and organic bottom grounding wave.
 */
export function HeroVisual({ size = "hero", className = "" }: HeroVisualProps) {
  const isHero = size === "hero";

  return (
    <div
      aria-hidden="true"
      className={`relative mx-auto flex w-full items-end justify-center select-none ${
        isHero
          ? "max-w-[360px] sm:max-w-[460px] md:max-w-[520px] lg:max-w-[620px] xl:max-w-[660px]"
          : "max-w-[340px] sm:max-w-[420px] md:max-w-[460px] lg:max-w-[520px]"
      } ${className}`}
    >
      {/* Soft diffused blush background wash — gentle ambient glow, no harsh circular edges */}
      <div className="pointer-events-none absolute -inset-x-8 -inset-y-6 rounded-[4rem] bg-gradient-to-tr from-[#FFD9E8]/35 via-[#FFF1F6]/70 to-transparent blur-3xl" />

      {/* Doodle 1: Crown above the girl's head (left child) */}
      <svg
        className="pointer-events-none absolute left-[13%] top-[1%] z-20 h-8 w-10 -rotate-12 text-rio-rose/85 sm:left-[15%] sm:top-[2%] sm:h-10 sm:w-12 lg:h-11 lg:w-13"
        viewBox="0 0 48 38"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 30 L4 12 L16 20 L24 6 L32 20 L44 12 L42 30 Z" />
        <circle cx="4" cy="9" r="2.5" fill="currentColor" />
        <circle cx="24" cy="4" r="2.5" fill="currentColor" />
        <circle cx="44" cy="9" r="2.5" fill="currentColor" />
      </svg>

      {/* Doodle 2: Playful celebration sparkle rays to the left */}
      <svg
        className="pointer-events-none absolute left-[1%] top-[22%] z-20 h-7 w-7 text-rio-rose/75 sm:left-[3%] sm:h-8 sm:w-8 lg:h-9 lg:w-9"
        viewBox="0 0 32 32"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <line x1="8" y1="16" x2="1" y2="16" />
        <line x1="11" y1="11" x2="5" y2="5" />
        <line x1="16" y1="8" x2="16" y2="1" />
      </svg>

      {/* Doodle 3: Outlined heart near top-right of the boy */}
      <svg
        className="pointer-events-none absolute right-[5%] top-[1%] z-20 h-8 w-8 rotate-12 text-rio-rose/75 sm:right-[8%] sm:top-[3%] sm:h-10 sm:w-10 lg:h-11 lg:w-11"
        viewBox="0 0 40 40"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M20 34 C10 25, 4 19, 4 13 C4 8, 8 4, 13 4 C16.5 4, 19 6, 20 8 C21 6, 23.5 4, 27 4 C32 4, 36 8, 36 13 C36 19, 30 25, 20 34 Z" />
        <line x1="33" y1="3" x2="36" y2="1" />
        <line x1="38" y1="6" x2="41" y2="5" />
      </svg>

      {/* Standalone photorealistic subjects */}
      <div className="relative z-10 w-full overflow-hidden">
        <Image
          src="/images/hero-children.webp"
          alt="Two cheerful Indian children, a smiling girl in pink and boy in blue propping their chins"
          width={1154}
          height={743}
          priority
          sizes={
            isHero
              ? "(max-width: 640px) 92vw, (max-width: 1024px) 75vw, 640px"
              : "(max-width: 640px) 92vw, (max-width: 1024px) 70vw, 520px"
          }
          className="mx-auto block h-auto w-full object-contain drop-shadow-sm transition-transform duration-300"
        />

        {/* Soft organic cloud/wave bottom grounding shape */}
        <div className="pointer-events-none absolute -bottom-1 inset-x-0 h-10 sm:h-12 bg-gradient-to-t from-[#fff8fb] via-[#fff8fb]/85 to-transparent" />
      </div>
    </div>
  );
}
