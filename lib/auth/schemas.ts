import { z } from "zod";
import { getEvent } from "@/lib/events";

// All input is validated on the server. These are the only shapes the auth actions accept.
// Invisible characters (zero-width space, joiner, word joiner, byte-order mark) often ride along when an address is copied from a web
// page or a chat. They are not part of any address and cannot be seen, so they are removed BEFORE the normal check; the rest of the
// check is unchanged, so nothing that was invalid becomes valid.
const INVISIBLE = /[​-‍⁠﻿]/g;
export const emailSchema = z
  .string()
  .max(1000)
  .transform((s) => s.replace(INVISIBLE, ""))
  .pipe(z.string().trim().toLowerCase().max(254).pipe(z.email()));

// Exactly `length` digits (see otp-length.ts); spaces are allowed so a code copied as "123 456" still works.
// The value stays a string, so a leading zero is kept. [0-9], so no other script's digits pass.
export const otpSchema = (length: number) =>
  z
    .string()
    .max(64)
    .transform((s) => s.replace(/\s+/g, ""))
    .pipe(z.string().regex(new RegExp(`^[0-9]{${length}}$`)));

/** The selected competition, only if it is one of the six known slugs. Anything else (including a URL) is dropped. */
export function parseEventSlug(value: unknown): string | null {
  return typeof value === "string" && getEvent(value) ? value : null;
}
