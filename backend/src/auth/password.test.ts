import { describe, expect, it } from "vitest";
import { dummyHash, generatePassword, hashPassword, needsRehash, passwordProblems, verifyPassword } from "./password.ts";
import { csrfFor, newToken, sameText, sha256Hex, TOKEN_PATTERN } from "./tokens.ts";

const cost = { memoryKib: 1024, passes: 1 }; // cheap on purpose: these tests check behaviour, not strength

describe("Argon2id password hashing", () => {
  it("writes a self-describing Argon2id PHC string with a fresh salt each time", async () => {
    const a = await hashPassword("correct horse battery", cost);
    const b = await hashPassword("correct horse battery", cost);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("correct horse");
  });

  it("accepts the right password and refuses a wrong, empty or near-miss one", async () => {
    const hash = await hashPassword("correct horse battery", cost);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batter", hash)).toBe(false);
    expect(await verifyPassword("Correct horse battery", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("treats the same text typed in different Unicode forms as one password, and keeps Tamil intact", async () => {
    const hash = await hashPassword("ａｂｃｄ１２３４５６７８", cost); // full-width characters
    expect(await verifyPassword("abcd12345678", hash)).toBe(true); // NFKC folds them to ASCII
    const tamil = await hashPassword("தமிழ்நாடு-பாதுகாப்பு-2026", cost);
    expect(await verifyPassword("தமிழ்நாடு-பாதுகாப்பு-2026", tamil)).toBe(true);
    expect(await verifyPassword("தமிழ்நாடு-பாதுகாப்பு-2027", tamil)).toBe(false);
  });

  it.each([
    ["an empty value", ""],
    ["plain text", "not a hash"],
    ["bcrypt", "$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345"],
    ["argon2i", "$argon2i$v=19$m=1024,t=1,p=1$c29tZXNhbHRzb21lc2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g"],
    ["a memory cost that would exhaust the server", "$argon2id$v=19$m=4000000,t=1,p=1$c29tZXNhbHRzb21lc2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g"],
    ["an absurd pass count", "$argon2id$v=19$m=1024,t=99,p=1$c29tZXNhbHRzb21lc2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g"],
  ])("answers no (and does not throw or hang) for a stored value that is %s", async (_label, stored) => {
    await expect(verifyPassword("anything", stored)).resolves.toBe(false);
  });

  it("notices a hash that is weaker than the current settings so it can be upgraded", async () => {
    const old = await hashPassword("some long password", { memoryKib: 1024, passes: 1 });
    expect(needsRehash(old, { memoryKib: 1024, passes: 1 })).toBe(false);
    expect(needsRehash(old, { memoryKib: 2048, passes: 1 })).toBe(true);
    expect(needsRehash(old, { memoryKib: 1024, passes: 2 })).toBe(true);
    expect(needsRehash("$2b$12$bcrypt", cost)).toBe(true);
    const upgraded = await hashPassword("some long password", { memoryKib: 2048, passes: 2 });
    expect(await verifyPassword("some long password", old)).toBe(true); // the old hash still works until it is replaced
    expect(await verifyPassword("some long password", upgraded)).toBe(true);
  });

  it("reuses one dummy hash per cost, so an unknown account costs the same as a real check", async () => {
    const first = await dummyHash(cost);
    expect(await dummyHash(cost)).toBe(first);
    expect(await verifyPassword("whatever", first)).toBe(false);
  });
});

describe("password rules", () => {
  it("accepts a long, varied password", () => {
    expect(passwordProblems("blue-lantern-42-river", "someone@example.org")).toEqual([]);
    expect(passwordProblems("தமிழ்-பாதுகாப்பு-கடவுச்சொல்", "someone@example.org")).toEqual([]);
  });

  it.each([
    ["short12", "shorter than 12 characters"],
    ["a".repeat(129), "longer than 128 characters"],
    ["aaaaaaaaaaaaaa", "too few different characters"],
    ["password123", "shorter than 12 characters"],
    ["Administrator", "a commonly used password"],
    ["  spaced-out-pw1", "starts or ends with a space"],
    ["has-rajesh-in-it-1", "contains the e-mail name"],
  ])("refuses %j because it is %s", (password, label) => {
    expect(passwordProblems(password, "rajesh@example.org")).toContain(label);
  });

  it("counts characters, not UTF-16 units (an emoji is one character)", () => {
    expect(passwordProblems("😀".repeat(11), "x@example.org")).toContain("shorter than 12 characters");
    expect(passwordProblems("😀😁😂🤣😃😄😅😆😉😊😋😎", "x@example.org")).toEqual([]);
  });

  it("generates 24-character grouped passwords that satisfy the rules, from a secure source", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = generatePassword();
      expect(p).toMatch(/^[a-zA-Z2-9]{4}(-[a-zA-Z2-9]{4}){4}$/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[2-9]/);
      expect(p).not.toMatch(/[01lIO]/);
      expect(passwordProblems(p, "someone@example.org")).toEqual([]);
      seen.add(p);
    }
    expect(seen.size).toBe(50);
  });
});

describe("session and CSRF tokens", () => {
  it("makes 256-bit URL-safe tokens that differ every time", () => {
    const tokens = new Set(Array.from({ length: 200 }, newToken));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(t).toMatch(TOKEN_PATTERN);
  });

  it("stores a token as a lower-case hex SHA-256 digest that does not contain the token", () => {
    const t = newToken();
    const digest = sha256Hex(t);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(t);
    expect(sha256Hex(t)).toBe(digest);
  });

  it("derives a stable CSRF token per session that differs between sessions and from the session token", () => {
    const a = newToken();
    const b = newToken();
    expect(csrfFor(a)).toBe(csrfFor(a));
    expect(csrfFor(a)).not.toBe(csrfFor(b));
    expect(csrfFor(a)).not.toBe(a);
    expect(csrfFor(a)).not.toBe(sha256Hex(a));
  });

  it("compares in constant time and handles different lengths", () => {
    expect(sameText("abc", "abc")).toBe(true);
    expect(sameText("abc", "abd")).toBe(false);
    expect(sameText("abc", "abcd")).toBe(false);
    expect(sameText("", "")).toBe(true);
  });
});
