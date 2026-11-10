import { z } from "zod";
import { AGE_MAX, AGE_MIN, fitsAge, type CompetitionEvent } from "@/lib/events";
import { reg, type Msg } from "./messages";

// Server-side validation for the registration form. Only the fields below are ever read from the submitted form:
// anything else a client adds (an owner id, a status, a video key, a different email) is ignored, because the
// action picks keys explicitly and the database does not let a parent write those columns anyway.
// Only collected: child name, age in years, parent name, mobile, and the consent choices. No date of birth.

export type Field = "childName" | "childAge" | "parentName" | "mobile" | "guardianConsent";
export type FieldErrors = Partial<Record<Field, Msg>>;

// Letters and combining marks from any script (Tamil vowel signs are marks), spaces, and . ' ’ - ; no digits.
const NAME = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;
const name = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, " "))
  .pipe(z.string().min(1).max(80).regex(NAME));

/** "+91 98765-43210", "09876543210" and "9876543210" all become "+919876543210"; anything else is null. */
export function normalizeMobile(input: string): string | null {
  const text = input.trim();
  if (!/^[+0-9 ()-]{10,20}$/.test(text)) return null;
  const match = text.replace(/\D/g, "").match(/^(?:91|0)?([6-9]\d{9})$/);
  return match ? `+91${match[1]}` : null;
}

const mobile = z
  .string()
  .refine((s) => normalizeMobile(s) !== null)
  .transform((s) => normalizeMobile(s) as string);

const age = z
  .string()
  .regex(/^\d{1,2}$/)
  .transform(Number)
  .pipe(z.number().int().min(AGE_MIN).max(AGE_MAX));

// A checkbox is "on" or it is not; any other value is simply "not ticked" (it must never throw).
const isChecked = (value: string | undefined) => value === "on";

const FIELDS = ["childName", "childAge", "parentName", "mobile", "guardianConsent", "mediaConsent", "consentVersion", "draftId", "event"] as const;

/** Picks only the known keys from a form submission. */
export function pickFields(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FIELDS) {
    const v = formData.get(key);
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

export type Registration = {
  childName: string;
  childAge: number;
  parentName: string;
  mobile: string; // canonical +91XXXXXXXXXX
  guardianConsent: boolean;
  mediaConsent: boolean;
};

/**
 * Validates the form for one competition. `requireConsent` is true when creating a registration (the guardian
 * consent is recorded then) and false when editing a draft (consent stays as given).
 */
export function parseRegistration(
  event: CompetitionEvent,
  raw: Record<string, string>,
  requireConsent: boolean,
): { ok: true; data: Registration } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const childName = name.safeParse(raw.childName ?? "");
  if (!childName.success) errors.childName = reg.errors.name;
  const parentName = name.safeParse(raw.parentName ?? "");
  if (!parentName.success) errors.parentName = reg.errors.name;
  const mobileResult = mobile.safeParse(raw.mobile ?? "");
  if (!mobileResult.success) errors.mobile = reg.errors.mobile;

  const ageResult = age.safeParse(raw.childAge ?? "");
  if (!ageResult.success) errors.childAge = reg.errors.age;
  else if (!fitsAge(event, ageResult.data)) errors.childAge = reg.errors.ageBand(event.minAge, event.maxAge);

  const guardian = isChecked(raw.guardianConsent);
  if (requireConsent && !guardian) errors.guardianConsent = reg.errors.consent;
  const media = isChecked(raw.mediaConsent);

  if (Object.keys(errors).length > 0 || !childName.success || !parentName.success || !mobileResult.success || !ageResult.success) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    data: { childName: childName.data, childAge: ageResult.data, parentName: parentName.data, mobile: mobileResult.data, guardianConsent: guardian, mediaConsent: media },
  };
}

export const draftIdSchema = z.uuid();
