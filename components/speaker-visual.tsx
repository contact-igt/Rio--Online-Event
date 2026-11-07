import Image from "next/image";

/**
 * Visual matching the approved registration/competition mock-up (03-registration.png).
 * Features an enthusiastic Indian child speaking into a microphone with soft celebration doodles.
 */
export function SpeakerVisual({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`relative flex items-center justify-center select-none ${className}`}
    >
      {/* Soft circular pink wash behind the child */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 size-48 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-tr from-rio-pink/25 to-rio-blush blur-xl sm:size-60" />

      {/* Sparkles / celebration rays */}
      <svg
        className="pointer-events-none absolute -top-1 right-2 z-20 h-7 w-7 text-rio-rose/80 sm:right-4 sm:h-8 sm:w-8"
        viewBox="0 0 32 32"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <line x1="16" y1="6" x2="16" y2="1" />
        <line x1="23" y1="9" x2="27" y2="5" />
        <line x1="26" y1="16" x2="31" y2="16" />
      </svg>

      <svg
        className="pointer-events-none absolute bottom-12 left-1 z-20 h-6 w-6 -rotate-45 text-rio-rose/70"
        viewBox="0 0 32 32"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <line x1="16" y1="6" x2="16" y2="1" />
        <line x1="23" y1="9" x2="27" y2="5" />
        <line x1="26" y1="16" x2="31" y2="16" />
      </svg>

      {/* Photorealistic standalone speaker child */}
      <Image
        src="/images/speaker-child.webp"
        alt="Enthusiastic young Indian child speaking into a microphone"
        width={423}
        height={769}
        priority
        className="relative z-10 h-auto w-36 object-contain drop-shadow-sm sm:w-44 lg:w-48"
      />
    </div>
  );
}

