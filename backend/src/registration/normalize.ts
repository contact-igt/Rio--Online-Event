// Turning what a parent typed into what is stored and compared. The database never normalises text (it compares code points exactly), so
// every rule that decides "is this the same child or the same number" lives here, in one place, and is tested.
//
//   display text   NFC, runs of white space collapsed to one space, trimmed. Tamil is never transliterated, re-ordered or stripped.
//   name key       the display text, lower-cased, zero-width joiners removed, punctuation that people type differently (. , ' ’ - _) turned
//                  into spaces, white space collapsed. It is the "child_name_norm" column that the one-finalized-entry rule uses.
//   mobile         "+91" and ten digits, from the many ways of writing an Indian mobile number, including Tamil and other Indic digits.

export const cleanText = (text: string): string => text.normalize("NFC").replace(/\s+/gu, " ").trim();

// Zero-width space, non-joiner, joiner, no-break marker and word joiner: invisible, so they must not make two names differ.
const INVISIBLE = [0x200b, 0x200c, 0x200d, 0xfeff, 0x2060].map((cp) => String.fromCharCode(cp)).join("");
const ZERO_WIDTH = new RegExp(`[${INVISIBLE}]`, "gu");
const NAME_PUNCTUATION = /[.,'’‘`´_-]+/gu;

export function nameKey(text: string): string {
  return cleanText(text)
    .toLowerCase()
    .normalize("NFC")
    .replace(ZERO_WIDTH, "")
    .replace(NAME_PUNCTUATION, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** A letter first, then letters and combining marks of any script (Tamil vowel signs are marks), spaces and the usual name punctuation. ZWNJ/ZWJ are allowed inside. */
const JOINERS = String.fromCharCode(0x200c, 0x200d);
const NAME_SHAPE = new RegExp(String.raw`^\p{L}[\p{L}\p{M}` + JOINERS + String.raw` .'’-]*$`, "u");
export const NAME_MAX = 80;

/** Null when the text cannot be a person's name; otherwise the cleaned display text. */
export function parseName(raw: string): string | null {
  const text = cleanText(raw);
  const length = [...text].length;
  if (length < 1 || length > NAME_MAX || !NAME_SHAPE.test(text) || nameKey(text) === "") return null;
  return text;
}

// ---- mobile numbers ----------------------------------------------------------------------------------------------------------------------------

// The code point of "zero" in the decimal-digit blocks a parent in India is likely to type with.
const ZEROS = [0x30, 0x0660, 0x06f0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0xff10];

function asciiDigits(text: string): string | null {
  let out = "";
  for (const ch of text.normalize("NFKC")) {
    const cp = ch.codePointAt(0)!;
    const zero = ZEROS.find((z) => cp >= z && cp <= z + 9);
    if (zero === undefined) return null;
    out += String(cp - zero);
  }
  return out;
}

/** "+91" followed by ten digits that start with 6 to 9, or null. Accepts spaces, hyphens, dots, brackets, a leading +91, 91 or 0. */
export function parseMobile(raw: string): string | null {
  const stripped = raw.normalize("NFKC").replace(/[\s\-.()]/gu, "");
  if (stripped === "" || stripped.length > 20) return null;
  const hadPlus = stripped.startsWith("+");
  const digits = asciiDigits(hadPlus ? stripped.slice(1) : stripped);
  if (digits === null) return null;
  let national = digits;
  if (hadPlus) {
    if (!digits.startsWith("91")) return null;
    national = digits.slice(2);
  } else if (digits.length === 12 && digits.startsWith("91")) national = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) national = digits.slice(1);
  return /^[6-9][0-9]{9}$/.test(national) ? `+91${national}` : null;
}

// ---- e-mail ---------------------------------------------------------------------------------------------------------------------------------------

/** Lower-cased and trimmed; an empty value means "none given". Shape is checked by the schema. */
export const cleanEmail = (raw: string): string | null => {
  const text = raw.normalize("NFKC").trim().toLowerCase();
  return text === "" ? null : text;
};
