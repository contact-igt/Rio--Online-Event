import { winnersLine } from "@/lib/events";
import type { Msg } from "@/lib/auth/messages";

// Public results page copy, Tamil first. The Tamil is mine and provisional until the native-speaker review (D13).
// No date is hardcoded: the announcement date comes from lib/events.ts and is empty until the client approves it. The page never shows
// the scheduled publication time and never invents a winner, a name or a date.

export const results = {
  title: { ta: "முடிவுகள்", en: "Results" } satisfies Msg,
  pending: winnersLine() satisfies Msg,
  none: { ta: "வெற்றியாளர்கள் இன்னும் அறிவிக்கப்படவில்லை.", en: "No winners have been announced yet." } satisfies Msg,
  unavailable: { ta: "முடிவுகள் இப்போது கிடைக்கவில்லை. சிறிது நேரம் கழித்து முயலுங்கள்.", en: "Results are unavailable right now. Please try again later." } satisfies Msg,
  place: { ta: "இடம்", en: "Place" } satisfies Msg,
  back: { ta: "முகப்புக்குத் திரும்பு", en: "Back to home" } satisfies Msg,
};
