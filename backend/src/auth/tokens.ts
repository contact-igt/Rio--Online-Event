import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Session tokens are 32 random bytes (256 bits) in base64url. The browser holds the token; the database holds only its SHA-256, so a copy
// of the database cannot be replayed as a session. A fast hash is right here (unlike for passwords) because the token is already random.

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const newToken = (): string => randomBytes(32).toString("base64url");
export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The CSRF token of a session: an HMAC of the session token. It is returned in the body of login and /me and must come back in the
 * X-CSRF-Token header of every state-changing request. A page on another origin can make the browser send the cookie but can neither read
 * this value (the API answers cross-origin reads only to allowed origins) nor compute it (it would need the cookie, which JavaScript
 * cannot read). No extra secret or column is needed because the session token is itself secret and unique per session.
 */
export const csrfFor = (sessionToken: string): string => createHmac("sha256", sessionToken).update("rio-staff-csrf-v1").digest("base64url");

export function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
