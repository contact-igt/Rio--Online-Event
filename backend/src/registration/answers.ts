import { cleanText } from "./normalize.ts";

// Checking one answer against the question it belongs to. The question set was fixed when the draft was created, so the rules are the ones
// the parent was shown. The database separately guarantees that an answer matches its question's type and set (composite foreign keys).

export type QuestionType = "short_text" | "paragraph" | "dropdown" | "radio" | "checkboxes" | "number" | "instruction";
export type Option = { code: string; ta: string; en: string };
export type Question = {
  id: number;
  key: string;
  type: QuestionType;
  position: number;
  promptTa: string;
  promptEn: string;
  helpTa: string | null;
  helpEn: string | null;
  required: boolean;
  options: Option[] | null;
  maxLength: number | null;
  minNumber: number | null;
  maxNumber: number | null;
};

/** What is stored: text for the text and single-choice types, a number, or the chosen option codes for checkboxes. `null` means "no answer". */
export type AnswerValue = string | number | string[];
export type Checked = { ok: true; value: AnswerValue | null } | { ok: false; problem: string };

const DEFAULT_SHORT = 200;
const DEFAULT_LONG = 2000;
const HARD_LONG = 4000; // the column is VARCHAR(4000)
const CONTROL = /[\p{Cc}]/u;
const bad = (problem: string): Checked => ({ ok: false, problem });
const count = (text: string) => [...text].length;

export function checkAnswer(q: Question, raw: unknown): Checked {
  if (q.type === "instruction") return bad("no_answer_allowed");
  if (raw === null) return { ok: true, value: null };

  switch (q.type) {
    case "short_text": {
      if (typeof raw !== "string") return bad("wrong_type");
      const text = cleanText(raw);
      if (text === "") return { ok: true, value: null };
      if (CONTROL.test(text)) return bad("invalid_text");
      return count(text) > Math.min(q.maxLength ?? DEFAULT_SHORT, HARD_LONG) ? bad("too_long") : { ok: true, value: text };
    }
    case "paragraph": {
      if (typeof raw !== "string") return bad("wrong_type");
      const text = raw.normalize("NFC").replace(/\r\n?/gu, "\n").replace(/[ \t]+\n/gu, "\n").trim();
      if (text === "") return { ok: true, value: null };
      if (/[\p{Cc}]/u.test(text.replace(/\n/gu, ""))) return bad("invalid_text");
      return count(text) > Math.min(q.maxLength ?? DEFAULT_LONG, HARD_LONG) ? bad("too_long") : { ok: true, value: text };
    }
    case "dropdown":
    case "radio": {
      if (typeof raw !== "string") return bad("wrong_type");
      if (raw === "") return { ok: true, value: null };
      return q.options?.some((o) => o.code === raw) ? { ok: true, value: raw } : bad("not_an_option");
    }
    case "checkboxes": {
      if (!Array.isArray(raw)) return bad("wrong_type");
      if (raw.length === 0) return { ok: true, value: null };
      if (new Set(raw).size !== raw.length) return bad("duplicate");
      const codes = q.options?.map((o) => o.code) ?? [];
      if (!raw.every((c) => typeof c === "string" && codes.includes(c))) return bad("not_an_option");
      return { ok: true, value: codes.filter((c) => raw.includes(c)) }; // stored in the order the options are shown
    }
    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) return bad("wrong_type");
      if ((q.minNumber !== null && raw < q.minNumber) || (q.maxNumber !== null && raw > q.maxNumber)) return bad("out_of_range");
      return { ok: true, value: raw };
    }
  }
}

/** The required questions that have no answer yet. Checked when the entry is submitted (a later module); a draft may be incomplete. */
export function missingRequired(questions: readonly Question[], answered: ReadonlySet<string>): string[] {
  return questions.filter((q) => q.required && q.type !== "instruction" && !answered.has(q.key)).map((q) => q.key);
}
