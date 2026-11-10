import { createHmac, randomInt } from "node:crypto";

// The two random strings a registration hands out.
//
//   recovery code   24 characters from Crockford's base32 (no I, L, O or U), 120 bits, shown to the parent in six groups of four. It is the
//                   ONLY way back into a draft: the same value rides in an HttpOnly cookie on the device that registered, and can be typed on
//                   another device. Only its SHA-256 is stored. A person's name or mobile number never opens anything.
//   entry reference 10 characters of the same alphabet: the anonymous label that judges and administrators see instead of a child's name.
//                   It identifies, it does not authenticate.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const random = (length: number): string => Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

export const newRecoveryCode = (): string => random(24);
export const newEntryReference = (): string => random(10);

/** 4-4-4-4-4-4 for reading and typing. */
export const showRecoveryCode = (code: string): string => code.match(/.{4}/gu)!.join("-");

/** What a person typed or pasted, reduced to the stored form: separators dropped, letters upper-cased, the usual look-alikes mapped (O->0, I/L->1). Null if it cannot be a code. */
export function canonicalCode(typed: string): string | null {
  const text = typed
    .normalize("NFKC")
    .replace(/[\s-]/gu, "")
    .toUpperCase()
    .replace(/O/gu, "0")
    .replace(/[IL]/gu, "1");
  return /^[0-9A-HJKMNP-TV-Z]{24}$/.test(text) ? text : null;
}

/** The CSRF token of a registration cookie, derived from the code so no extra column is needed. Different label from the staff one, so the two can never be swapped. */
export const registrationCsrf = (code: string): string => createHmac("sha256", code).update("rio-registration-csrf-v1").digest("base64url");
