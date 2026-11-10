import { describe, expect, it } from "vitest";
import { csrfFor } from "../auth/tokens.ts";
import { checkAnswer, missingRequired, type Question } from "./answers.ts";
import { canonicalCode, newEntryReference, newRecoveryCode, registrationCsrf, showRecoveryCode } from "./codes.ts";
import { cleanEmail, cleanText, nameKey, parseMobile, parseName } from "./normalize.ts";

const COMPOSED = "கொ"; // KA + vowel sign O
const DECOMPOSED = "கொ"; // KA + vowel sign E + AA length mark: the same letter in another code point order

describe("text cleaning and name keys", () => {
  it("normalises to NFC and collapses white space of every kind", () => {
    expect(cleanText(DECOMPOSED)).toBe(COMPOSED);
    expect(cleanText("  Asha  \n\t Kumar  ")).toBe("Asha Kumar");
  });

  it("gives the same key for spellings people use interchangeably", () => {
    const same = ["Asha Kumar", "ASHA KUMAR", "  asha   kumar ", "Asha-Kumar", "Asha. Kumar", "asha_kumar", "Asha​ Kumar"];
    for (const text of same) expect(nameKey(text), text).toBe("asha kumar");
    expect(nameKey("Mary-Ann O’Neil")).toBe(nameKey("mary ann o'neil"));
    expect(nameKey("Asha K.")).toBe(nameKey("Asha K"));
  });

  it("treats composed and decomposed Tamil as one name, and different Tamil names as different", () => {
    expect(nameKey(`பா${COMPOSED}`)).toBe(nameKey(`பா${DECOMPOSED}`));
    expect(nameKey("அன்பு")).not.toBe(nameKey("அம்பு"));
    expect(nameKey("கீர்த்தனா ஸ்ரீ")).toBe("கீர்த்தனா ஸ்ரீ"); // nothing stripped, transliterated or reordered
  });

  it("accepts real names in any script", () => {
    for (const name of ["கீர்த்தனா ஸ்ரீ", "அ".repeat(80), "Mary-Ann O'Neil", "José", "Åsa", "محمد", "ராமன் K."]) expect(parseName(name), name).not.toBeNull();
    expect(parseName(` ${DECOMPOSED}  அ `)).toBe(`${COMPOSED} அ`);
  });

  it.each(["", "   ", "Asha2", "<script>", "Asha; DROP TABLE", "😀", "Asha😀", "-Asha", "அ".repeat(81), "ொ", "Asha\u0000", "12345"])("refuses %j as a name", (text) => {
    expect(parseName(text)).toBeNull();
  });
});

describe("Indian mobile numbers", () => {
  it.each([
    "9876543210", "09876543210", "919876543210", "+919876543210", "+91 98765 43210", "98765-43210", "(+91) 98765.43210", " +91-9876543210 ",
    "௯௮௭௬௫௪௩௨௧௦", // Tamil digits
    "९८७६५४३२१०", // Devanagari digits
    "９８７６５４３２１０", // full-width digits
  ])("normalises %j to +919876543210", (raw) => {
    expect(parseMobile(raw)).toBe("+919876543210");
  });

  it.each(["", "5876543210", "98765432", "98765432101", "+449876543210", "+91 5876543210", "abc", "98765 4321a", "+91+919876543210", "0091 9876543210", "+919876543210123456789", "9876543210; DROP"])(
    "refuses %j",
    (raw) => {
      expect(parseMobile(raw)).toBeNull();
    },
  );

  it("keeps the first digit rule: 6, 7, 8 and 9 only", () => {
    for (const first of "6789") expect(parseMobile(`${first}123456789`)).toBe(`+91${first}123456789`);
    for (const first of "012345") expect(parseMobile(`${first}123456789`)).toBeNull();
  });
});

describe("e-mail", () => {
  it("lower-cases and trims; empty means none", () => {
    expect(cleanEmail("  Parent@Example.ORG ")).toBe("parent@example.org");
    expect(cleanEmail("   ")).toBeNull();
    expect(cleanEmail("")).toBeNull();
  });
});

describe("recovery codes and references", () => {
  it("makes 24-character codes from the unambiguous alphabet, different every time", () => {
    const codes = new Set(Array.from({ length: 300 }, newRecoveryCode));
    expect(codes.size).toBe(300);
    for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{24}$/);
  });

  it("makes 10-character references that satisfy the database's entry_code rule", () => {
    for (let i = 0; i < 100; i++) expect(newEntryReference()).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
  });

  it("shows a code in six groups of four and reads it back however it was typed", () => {
    const code = "K7M293QX4PTB8WRVZD5H1AEF";
    expect(showRecoveryCode(code)).toBe("K7M2-93QX-4PTB-8WRV-ZD5H-1AEF");
    for (const typed of ["K7M2-93QX-4PTB-8WRV-ZD5H-1AEF", "k7m2-93qx-4ptb-8wrv-zd5h-1aef", "K7M2 93QX 4PTB 8WRV ZD5H 1AEF", " K7M293QX4PTB8WRVZD5H1AEF ", "k7m293qx4ptb8wrvzd5h1aef"]) {
      expect(canonicalCode(typed), typed).toBe(code);
    }
    expect(canonicalCode("K7M2-93QX-4PTB-8WRV-ZD5H-lAEF")).toBe(code); // l -> 1
    expect(canonicalCode("K7M2-93QX-4PTB-8WRV-ZD5H-IAEF")).toBe(code); // I -> 1
    expect(canonicalCode("K7M2-93QX-4PTB-8WRV-ZD5H-OAEF")).toBe("K7M293QX4PTB8WRVZD5H0AEF"); // O -> 0
  });

  it.each(["", "short", "K7M2-93QX-4PTB-8WRV-ZD5H", "K7M2-93QX-4PTB-8WRV-ZD5H-1AEF-XXXX", "K7M2-93QX-4PTB-8WRV-ZD5H-1AEU", "K7M2-93QX-4PTB-8WRV-ZD5H-1AE!", "../../etc/passwd"])(
    "refuses %j as a code",
    (typed) => {
      expect(canonicalCode(typed)).toBeNull();
    },
  );

  it("keeps the registration CSRF token apart from the staff one", () => {
    const code = newRecoveryCode();
    expect(registrationCsrf(code)).toBe(registrationCsrf(code));
    expect(registrationCsrf(code)).not.toBe(csrfFor(code));
    expect(registrationCsrf(code)).not.toBe(registrationCsrf(newRecoveryCode()));
  });
});

describe("checking answers against their question", () => {
  const base: Question = { id: 1, key: "q", type: "short_text", position: 1, promptTa: "கே", promptEn: "Q", helpTa: null, helpEn: null, required: false, options: null, maxLength: null, minNumber: null, maxNumber: null };
  const options = [{ code: "a", ta: "அ", en: "A" }, { code: "b", ta: "ஆ", en: "B" }, { code: "c", ta: "இ", en: "C" }];
  const q = (over: Partial<Question>): Question => ({ ...base, ...over });

  it("cleans short text, counts characters, and clears an empty answer", () => {
    expect(checkAnswer(q({}), "  சென்னை   நகரம் ")).toEqual({ ok: true, value: "சென்னை நகரம்" });
    expect(checkAnswer(q({}), "   ")).toEqual({ ok: true, value: null });
    expect(checkAnswer(q({}), null)).toEqual({ ok: true, value: null });
    expect(checkAnswer(q({ maxLength: 5 }), "அ".repeat(5))).toEqual({ ok: true, value: "அ".repeat(5) });
    expect(checkAnswer(q({ maxLength: 5 }), "அ".repeat(6))).toEqual({ ok: false, problem: "too_long" });
    expect(checkAnswer(q({}), "a".repeat(201))).toEqual({ ok: false, problem: "too_long" });
    expect(checkAnswer(q({}), "bad\u0007text")).toEqual({ ok: false, problem: "invalid_text" });
    expect(checkAnswer(q({}), 5)).toEqual({ ok: false, problem: "wrong_type" });
  });

  it("keeps paragraph line breaks, drops control characters' company, and enforces its own limit", () => {
    expect(checkAnswer(q({ type: "paragraph" }), "முதல் வரி  \r\nஇரண்டாவது வரி\r\n")).toEqual({ ok: true, value: "முதல் வரி\nஇரண்டாவது வரி" });
    expect(checkAnswer(q({ type: "paragraph" }), "x\u0000y")).toEqual({ ok: false, problem: "invalid_text" });
    expect(checkAnswer(q({ type: "paragraph" }), "a".repeat(2001))).toEqual({ ok: false, problem: "too_long" });
    expect(checkAnswer(q({ type: "paragraph", maxLength: 3000 }), "a".repeat(3000)).ok).toBe(true);
    expect(checkAnswer(q({ type: "paragraph", maxLength: 9000 }), "a".repeat(4001))).toEqual({ ok: false, problem: "too_long" }); // the column limit still holds
  });

  it.each(["dropdown", "radio"] as const)("%s accepts only an offered code", (type) => {
    expect(checkAnswer(q({ type, options }), "b")).toEqual({ ok: true, value: "b" });
    expect(checkAnswer(q({ type, options }), "z")).toEqual({ ok: false, problem: "not_an_option" });
    expect(checkAnswer(q({ type, options }), "B")).toEqual({ ok: false, problem: "not_an_option" });
    expect(checkAnswer(q({ type, options }), ["a"])).toEqual({ ok: false, problem: "wrong_type" });
    expect(checkAnswer(q({ type, options }), "")).toEqual({ ok: true, value: null });
  });

  it("checkboxes take a duplicate-free list of offered codes, stored in the order shown", () => {
    const box = q({ type: "checkboxes", options });
    expect(checkAnswer(box, ["c", "a"])).toEqual({ ok: true, value: ["a", "c"] });
    expect(checkAnswer(box, [])).toEqual({ ok: true, value: null });
    expect(checkAnswer(box, ["a", "a"])).toEqual({ ok: false, problem: "duplicate" });
    expect(checkAnswer(box, ["a", "z"])).toEqual({ ok: false, problem: "not_an_option" });
    expect(checkAnswer(box, "a")).toEqual({ ok: false, problem: "wrong_type" });
    expect(checkAnswer(box, [1])).toEqual({ ok: false, problem: "not_an_option" });
  });

  it("numbers must be finite and inside the bounds", () => {
    const n = q({ type: "number", minNumber: 1, maxNumber: 10 });
    expect(checkAnswer(n, 5.5)).toEqual({ ok: true, value: 5.5 });
    expect(checkAnswer(n, 0)).toEqual({ ok: false, problem: "out_of_range" });
    expect(checkAnswer(n, 11)).toEqual({ ok: false, problem: "out_of_range" });
    expect(checkAnswer(n, "5")).toEqual({ ok: false, problem: "wrong_type" });
    expect(checkAnswer(n, Number.NaN)).toEqual({ ok: false, problem: "wrong_type" });
    expect(checkAnswer(n, Infinity)).toEqual({ ok: false, problem: "wrong_type" });
    expect(checkAnswer(q({ type: "number" }), -1e9)).toEqual({ ok: true, value: -1e9 });
  });

  it("an instruction takes no answer, not even an empty one", () => {
    expect(checkAnswer(q({ type: "instruction" }), "x")).toEqual({ ok: false, problem: "no_answer_allowed" });
    expect(checkAnswer(q({ type: "instruction" }), null)).toEqual({ ok: false, problem: "no_answer_allowed" });
  });

  it("lists the required questions that have no answer yet", () => {
    const list = [q({ key: "a", required: true }), q({ key: "b", required: true }), q({ key: "c" }), q({ key: "d", type: "instruction" })];
    expect(missingRequired(list, new Set(["a"]))).toEqual(["b"]);
    expect(missingRequired(list, new Set(["a", "b"]))).toEqual([]);
  });
});
