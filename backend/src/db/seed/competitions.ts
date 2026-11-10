// The six competitions, copied from website/lib/events.ts (the single source of truth for the public site). Only what the `events` table can
// hold is here: slug, Tamil and English name, age range, and the order the poster prints them. The task sentences have no column yet, and no dates,
// questions or consent text are seeded. A test (seed-events.test.ts) reads website/lib/events.ts and fails if this list ever drifts from it.
//
// The English names are plain-language glosses marked for owner confirmation in PROJECT_BRIEF.md; they are seeded as they stand there.

export type Competition = { number: number; slug: string; nameTa: string; nameEn: string; minAge: number; maxAge: number };

export const COMPETITIONS: readonly Competition[] = [
  { number: 1, slug: "malalai-mozhi", nameTa: "மழலை மொழி", nameEn: "Toddler Tamil", minAge: 3, maxAge: 5 },
  { number: 2, slug: "kathai-sollum-kutties", nameTa: "கதை சொல்லும் குட்டீஸ்", nameEn: "Little Storytellers", minAge: 5, maxAge: 8 },
  { number: 3, slug: "thirukkural-thiramai", nameTa: "திருக்குறள் திறமை", nameEn: "Thirukkural Talent", minAge: 6, maxAge: 12 },
  { number: 4, slug: "kutti-pesalar", nameTa: "குட்டிப் பேச்சாளர்", nameEn: "Little Speaker", minAge: 8, maxAge: 12 },
  { number: 5, slug: "tamil-kalaikoodam", nameTa: "தமிழ் கலைக்கூடம்", nameEn: "Tamil Art Studio", minAge: 5, maxAge: 12 },
  { number: 6, slug: "tamilil-sollu", nameTa: "தமிழில் சொல்லு!", nameEn: "Say It in Tamil", minAge: 6, maxAge: 12 },
];
