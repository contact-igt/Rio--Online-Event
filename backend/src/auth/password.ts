import { argon2, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

// Argon2id with Node's built-in implementation (no dependency). The stored value is a PHC string that records its own parameters, so a
// password hashed with older, cheaper settings still verifies and can be upgraded at the next successful login (needsRehash).
//
//   $argon2id$v=19$m=<KiB>,t=<passes>,p=1$<salt>$<hash>      (base64 without padding)
//
// A password is Unicode-normalised (NFKC) before hashing, so the same text typed on different keyboards or devices is one password.

export type Argon2Cost = { memoryKib: number; passes: number };
const PARALLELISM = 1;
const SALT_BYTES = 16;
const TAG_BYTES = 32;
// Ceilings for a stored hash we are asked to verify. They are larger than anything we write, but small enough that a corrupted or
// hostile value in the database cannot make one login allocate gigabytes.
const MAX_MEMORY_KIB = 262_144;
const MAX_PASSES = 10;

const PHC = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{16,64})\$([A-Za-z0-9+/]{32,128})$/;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/=+$/, "");
const normalise = (password: string) => Buffer.from(password.normalize("NFKC"), "utf8");

function derive(password: string, nonce: Buffer, memory: number, passes: number, parallelism: number, tagLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2("argon2id", { message: normalise(password), nonce, parallelism, tagLength, memory, passes }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string, cost: Argon2Cost): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const tag = await derive(password, salt, cost.memoryKib, cost.passes, PARALLELISM, TAG_BYTES);
  return `$argon2id$v=19$m=${cost.memoryKib},t=${cost.passes},p=${PARALLELISM}$${b64(salt)}$${b64(tag)}`;
}

type Parsed = { memory: number; passes: number; parallelism: number; salt: Buffer; tag: Buffer };
function parse(stored: string): Parsed | null {
  const m = PHC.exec(stored);
  if (!m) return null;
  const memory = Number(m[1]);
  const passes = Number(m[2]);
  const parallelism = Number(m[3]);
  if (memory < 8 * parallelism || memory > MAX_MEMORY_KIB || passes < 1 || passes > MAX_PASSES || parallelism < 1 || parallelism > 4) return null;
  return { memory, passes, parallelism, salt: Buffer.from(m[4]!, "base64"), tag: Buffer.from(m[5]!, "base64") };
}

/** True only for the right password. A malformed or out-of-bounds stored value is simply "no". Never throws for bad data. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const p = parse(stored);
  if (!p) return false;
  try {
    const candidate = await derive(password, p.salt, p.memory, p.passes, p.parallelism, p.tag.length);
    return candidate.length === p.tag.length && timingSafeEqual(candidate, p.tag);
  } catch {
    return false;
  }
}

/** The stored hash is weaker than the current settings (or not Argon2id at all) and should be replaced after a successful login. */
export function needsRehash(stored: string, cost: Argon2Cost): boolean {
  const p = parse(stored);
  return !p || p.memory < cost.memoryKib || p.passes < cost.passes || p.parallelism !== PARALLELISM;
}

// A hash of a password nobody has, computed once per cost. Verifying against it when the e-mail is unknown or the account is switched off
// makes that path cost the same as a real check, so response time does not reveal which e-mails are staff.
const dummies = new Map<string, Promise<string>>();
export function dummyHash(cost: Argon2Cost): Promise<string> {
  const key = `${cost.memoryKib}:${cost.passes}`;
  let hash = dummies.get(key);
  if (!hash) {
    hash = hashPassword(randomBytes(24).toString("base64"), cost);
    dummies.set(key, hash);
  }
  return hash;
}

// ---- choosing passwords ----------------------------------------------------------------------------------------------------------------------------

const LOWER = "abcdefghijkmnopqrstuvwxyz"; // no l
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O
const DIGIT = "23456789"; // no 0, 1
const pick = (set: string) => set[randomInt(set.length)]!;

/** 20 random letters and digits (at least 3 of each kind) in five groups of four: about 115 bits, and unambiguous when read from a screen. */
export function generatePassword(): string {
  const chars = [pick(LOWER), pick(LOWER), pick(LOWER), pick(UPPER), pick(UPPER), pick(UPPER), pick(DIGIT), pick(DIGIT), pick(DIGIT)];
  const all = LOWER + UPPER + DIGIT;
  while (chars.length < 20) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return [0, 4, 8, 12, 16].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

const COMMON = new Set(["password", "password1", "password123", "123456789012", "qwertyuiop12", "administrator", "letmein12345", "welcome12345"]);

/** Fixed labels explaining why a new password is refused; the password itself never appears in them. Counts characters, not UTF-16 units. */
export function passwordProblems(password: string, email: string): string[] {
  const out: string[] = [];
  const length = [...password].length;
  if (length < 12) out.push("shorter than 12 characters");
  if (length > 128) out.push("longer than 128 characters");
  if (new Set(password).size < 5) out.push("too few different characters");
  const local = email.split("@")[0] ?? "";
  if (local.length >= 4 && password.toLowerCase().includes(local.toLowerCase())) out.push("contains the e-mail name");
  if (COMMON.has(password.toLowerCase())) out.push("a commonly used password");
  if (/^\s|\s$/.test(password)) out.push("starts or ends with a space");
  return out;
}
