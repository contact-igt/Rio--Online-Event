// Single source of truth for the six competitions. Tamil names, ages and tasks come from the
// event poster. English names are plain-language glosses and English task lines are translations
// of the poster's Tamil; both are marked for owner confirmation in PROJECT_BRIEF.md.

export const AGE_MIN = 3;
export const AGE_MAX = 12;
export const AGES: readonly number[] = Array.from({ length: AGE_MAX - AGE_MIN + 1 }, (_, i) => AGE_MIN + i);

export type CompetitionEvent = {
  number: number;
  slug: string;
  nameTa: string;
  nameEn: string;
  minAge: number;
  maxAge: number;
  taskTa: string;
  taskEn: string;
};

export const events: readonly CompetitionEvent[] = [
  {
    number: 1,
    slug: "malalai-mozhi",
    nameTa: "மழலை மொழி",
    nameEn: "Toddler Tamil",
    minAge: 3,
    maxAge: 5,
    taskTa: "தமிழ் மழலைப் பாடல் அல்லது பிடித்த தமிழ் வார்த்தைகளை சொல்லுங்கள்!",
    taskEn: "Sing a Tamil rhyme or say your favourite Tamil words.",
  },
  {
    number: 2,
    slug: "kathai-sollum-kutties",
    nameTa: "கதை சொல்லும் குட்டீஸ்",
    nameEn: "Little Storytellers",
    minAge: 5,
    maxAge: 8,
    taskTa: "தமிழில் ஒரு சிறிய கதை சொல்லுங்கள்!",
    taskEn: "Tell a short story in Tamil.",
  },
  {
    number: 3,
    slug: "thirukkural-thiramai",
    nameTa: "திருக்குறள் திறமை",
    nameEn: "Thirukkural Talent",
    minAge: 6,
    maxAge: 12,
    taskTa: "ஒரு திருக்குறளைச் சொல்லி அதன் பொருளை விளக்குங்கள்!",
    taskEn: "Recite one Thirukkural and explain its meaning.",
  },
  {
    number: 4,
    slug: "kutti-pesalar",
    nameTa: "குட்டிப் பேச்சாளர்",
    nameEn: "Little Speaker",
    minAge: 8,
    maxAge: 12,
    taskTa: "தலைப்பு: “தமிழ் என் அடையாளம்” – 1 நிமிட உரை!",
    taskEn: "Give a 1-minute speech. Topic: “Tamil is my identity”.",
  },
  {
    number: 5,
    slug: "tamil-kalaikoodam",
    nameTa: "தமிழ் கலைக்கூடம்",
    nameEn: "Tamil Art Studio",
    minAge: 5,
    maxAge: 12,
    // The poster prints “கைவிளைப் பொருள்”, which looks like a typo for “கைவினைப் பொருள்” (handicraft).
    taskTa: "தமிழ் எழுத்துக்களைப் பயன்படுத்தி ஓவியம், கைவினைப் பொருள் உருவாக்குங்கள்!",
    taskEn: "Create a painting or craft using Tamil letters.",
  },
  {
    number: 6,
    slug: "tamilil-sollu",
    nameTa: "தமிழில் சொல்லு!",
    nameEn: "Say It in Tamil",
    minAge: 6,
    maxAge: 12,
    taskTa: "ஆங்கில வார்த்தைகளுக்கான சரியான தமிழ்ப் பொருளை சொல்லுங்கள்!",
    taskEn: "Say the correct Tamil word for each English word.",
  },
];

export const rules = {
  videoSeconds: { min: 30, max: 90 },
};

// Award names exactly as printed on the poster. The poster does not say which competition each belongs to.
export const awards: readonly string[] = [
  "Best Little Speaker",
  "Best Story Teller",
  "Best Tamil Scholar",
  "Creative Star",
  "Tamil Star",
  "Best Little Artist",
];

// The winners announcement date is pending client approval, so no date is hardcoded anywhere. Set it here (both languages) once the
// client approves it; every page and the confirmation e-mail then show it. Until then they say the date will be confirmed later.
export const announcement: { textEn: string; textTa: string } | null = null;

export function winnersLine(): { ta: string; en: string } {
  return announcement
    ? { ta: `வெற்றியாளர்கள் ${announcement.textTa} அன்று அறிவிக்கப்படுவார்கள்.`, en: `Winners will be announced on ${announcement.textEn}.` }
    : { ta: "வெற்றியாளர்கள் அறிவிப்புத் தேதி பின்னர் உறுதிசெய்யப்படும்.", en: "The winners announcement date will be confirmed later." };
}

export function getEvent(slug: string): CompetitionEvent | undefined {
  return events.find((e) => e.slug === slug);
}

export function fitsAge(event: CompetitionEvent, age: number): boolean {
  return age >= event.minAge && age <= event.maxAge;
}

export function sharedAges(a: CompetitionEvent, b: CompetitionEvent): { min: number; max: number } | null {
  const min = Math.max(a.minAge, b.minAge);
  const max = Math.min(a.maxAge, b.maxAge);
  return min <= max ? { min, max } : null;
}

export function ageRangeEn(min: number, max: number): string {
  return min === max ? `age ${min}` : `ages ${min}–${max}`;
}
