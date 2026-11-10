import { z } from "zod";
import { AppError } from "../http/errors.ts";
import { cleanEmail, cleanText, parseMobile, parseName } from "./normalize.ts";

// Request bodies, validated on the server with zod. Every object is strict (an unknown field is an error, not ignored). Text is NFC-normalised
// and the mobile number reduced to +91 and ten digits during parsing, so what the service sees is already the stored form. Errors name the
// field and a fixed problem code: a submitted value is never echoed back or logged.

export class ValidationFailed extends AppError {
  readonly fields: { field: string; problem: string }[];
  constructor(fields: { field: string; problem: string }[]) {
    super(422, "validation_failed", "Some details need to be corrected.");
    this.fields = fields;
  }
}

/** Zod issues -> field names and fixed codes. A message that is one of our own codes (lower-case words and underscores) is kept; zod's sentences are replaced by the issue type. */
export function fieldsOf(error: z.ZodError): { field: string; problem: string }[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join(".") : "(body)",
    problem: /^[a-z]+(_[a-z]+)*$/.test(issue.message) ? issue.message : issue.code,
  }));
}

export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw new ValidationFailed(fieldsOf(result.error));
  return result.data;
}

export const VERSION = /^[A-Za-z0-9._-]{1,40}$/;
const name = z.string().max(400, { message: "too_long" }).transform(cleanText).refine((v) => parseName(v) !== null, { message: "invalid_name" });
const mobile = z
  .string()
  .max(40, { message: "invalid_mobile" })
  .transform(parseMobile)
  .refine((v): v is string => v !== null, { message: "invalid_mobile" });
const email = z
  .string()
  .max(254, { message: "invalid_email" })
  .transform(cleanEmail)
  .refine((v) => v === null || z.email().safeParse(v).success, { message: "invalid_email" });
const age = z.number({ message: "invalid_age" }).int({ message: "invalid_age" }).min(1, { message: "out_of_range" }).max(18, { message: "out_of_range" });
const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: "invalid_slug" }).max(60, { message: "invalid_slug" });
const version = z.string().regex(VERSION, { message: "invalid_version" });

/** The guardian ticks the box for the wording of one version; the server records that version, not a bare "yes". */
const guardianConsent = z.strictObject({ accepted: z.literal(true, { message: "consent_required" }), version });
/** Optional and separate: granted true or false, for one version of the media wording. */
const mediaConsent = z.strictObject({ granted: z.boolean({ message: "invalid_value" }), version });

export const ANSWER_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const answers = z
  .record(z.string().regex(ANSWER_KEY, { message: "invalid_key" }), z.union([z.string().max(8000, { message: "too_long" }), z.number(), z.array(z.string().max(100)).max(50), z.null()]))
  .refine((r) => Object.keys(r).length <= 60, { message: "too_many" });

export const createBody = z.strictObject({
  eventSlug: slug,
  childName: name,
  childAge: age,
  guardianName: name,
  guardianMobile: mobile,
  guardianEmail: email.nullish(),
  guardianConsent,
  mediaConsent: mediaConsent.nullish(),
});
export type CreateInput = z.infer<typeof createBody>;

export const patchBody = z
  .strictObject({
    childName: name,
    childAge: age,
    guardianName: name,
    guardianMobile: mobile,
    guardianEmail: email.nullable(),
    guardianConsent,
    mediaConsent: mediaConsent.nullable(),
    answers,
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing_to_change" });
export type PatchInput = z.infer<typeof patchBody>;

export const recoverBody = z.strictObject({ code: z.string().max(64) });
