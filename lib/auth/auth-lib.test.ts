import { describe, expect, it } from "vitest";
import { COOLDOWN_MS, secondsLeft } from "./cooldown";
import { maskEmail } from "./email";
import { sendErrorMessage, verifyErrorMessage } from "./errors";
import { copy } from "./messages";
import { afterSignInPath, registerPath, signInPath, verifyPath } from "./paths";
import { createLimiter } from "./rate-limit";
import { isOtpLengthConfigError, resolveOtpLength } from "./otp-length";
import { emailSchema, otpSchema, parseEventSlug } from "./schemas";

describe("emailSchema", () => {
  it("accepts the ordinary shapes people really use, including tags, subdomains and surrounding whitespace", () => {
    for (const ok of ["first.last@gmail.com", "first+rio@gmail.com", "First.Last@Gmail.COM", "a@mail.example.co.in", "o'neil@example.com", "a_b@my-school.org", "12345@example.com", " parent@example.com\n", "\u00a0parent@example.com\u00a0"]) {
      expect(emailSchema.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    }
  });
  it("ignores invisible characters that ride along when an address is copied, and still refuses what is invalid", () => {
    expect(emailSchema.parse("parent@example.com\u200b")).toBe("parent@example.com");
    expect(emailSchema.parse("\ufeffParent@Example.com\u2060")).toBe("parent@example.com");
    expect(emailSchema.parse("par\u200dent@example.com")).toBe("parent@example.com");
    for (const bad of ["\u200b", "no-at\u200b-sign", "a\u200b@\u200bb", "a b@example.com", "par ent@example.com\u200b"]) {
      expect(emailSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("trims, lower-cases and accepts ordinary addresses", () => {
    expect(emailSchema.parse("  Parent.Name@Example.COM ")).toBe("parent.name@example.com");
  });
  it("rejects malformed and over-long addresses", () => {
    for (const bad of ["", "no-at-sign", "a@b", "a b@example.com", `${"x".repeat(250)}@example.com`]) expect(emailSchema.safeParse(bad).success, bad).toBe(false);
  });
});

describe("otpSchema", () => {
  it("accepts exactly the configured number of digits, with or without spaces", () => {
    expect(otpSchema(6).parse("123456")).toBe("123456");
    expect(otpSchema(6).parse(" 123 456 ")).toBe("123456");
    expect(otpSchema(8).parse("12345678")).toBe("12345678");
    expect(otpSchema(8).parse("1234 5678")).toBe("12345678");
  });
  it("works for every supported length (6 to 10) and no other", () => {
    for (let n = 6; n <= 10; n++) {
      const ok = "1234567890".slice(0, n);
      expect(otpSchema(n).parse(ok), String(n)).toBe(ok);
      expect(otpSchema(n).safeParse(ok.slice(1)).success, `${n} minus one`).toBe(false);
      expect(otpSchema(n).safeParse(ok + "1").success, `${n} plus one`).toBe(false);
    }
  });
  it("keeps leading zeros: the value is returned as a string, never as a number", () => {
    expect(otpSchema(6).parse("000123")).toBe("000123");
    expect(otpSchema(8).parse("00 04 83 92")).toBe("00048392");
  });
  it("rejects the wrong length, letters, punctuation, other scripts' digits and absurd input", () => {
    for (const bad of ["", "12345", "1234567", "12345a", "abcdef", "123-456", "١٢٣٤٥٦", "1".repeat(65)]) expect(otpSchema(6).safeParse(bad).success, bad).toBe(false);
    for (const bad of ["123456", "1234567", "123456789", "1234567a", "١٢٣٤٥٦٧٨"]) expect(otpSchema(8).safeParse(bad).success, bad).toBe(false);
  });
});

describe("resolveOtpLength", () => {
  it("defaults to 6 when the setting is absent or blank", () => {
    expect(resolveOtpLength({})).toBe(6);
    expect(resolveOtpLength({ RIO_OTP_LENGTH: "" })).toBe(6);
    expect(resolveOtpLength({ RIO_OTP_LENGTH: "  " })).toBe(6);
  });
  it("accepts whole numbers from 6 to 10", () => {
    for (let n = 6; n <= 10; n++) expect(resolveOtpLength({ RIO_OTP_LENGTH: String(n) })).toBe(n);
    expect(resolveOtpLength({ RIO_OTP_LENGTH: " 8 " })).toBe(8);
  });
  it("fails closed on anything else, with a fixed message that never echoes the value", () => {
    for (const bad of ["5", "11", "0", "-8", "8.5", "eight", "08x", "1e1", "100", "0x8"]) {
      let error: unknown;
      try {
        resolveOtpLength({ RIO_OTP_LENGTH: bad });
      } catch (e) {
        error = e;
      }
      expect(isOtpLengthConfigError(error), bad).toBe(true);
      if (bad.length >= 3) expect((error as Error).message.includes(bad), bad).toBe(false); // shorter values appear in the fixed text itself
    }
  });
});

describe("code messages follow the configured length, in both languages", () => {
  it("states the same number in Tamil and English", () => {
    for (let n = 6; n <= 10; n++) {
      for (const m of [copy.signIn.lead(n), copy.verify.codeLabel(n), copy.errors.invalidCode(n)]) {
        expect(m.ta, String(n)).toContain(`${n} `);
        expect(m.en, String(n)).toContain(`${n}-digit`);
        if (n !== 6) expect(m.ta + m.en, String(n)).not.toMatch(/ஆறு|six|6-digit|6 இலக்க/i); // no leftover hard-coded six
      }
    }
  });
});

describe("selected event handling (no open redirects)", () => {
  it("keeps only one of the six known slugs", () => {
    expect(parseEventSlug("kutti-pesalar")).toBe("kutti-pesalar");
    for (const bad of ["https://evil.example", "//evil.example", "/account", "nope", "", null, undefined, 5, ["kutti-pesalar"]]) expect(parseEventSlug(bad), String(bad)).toBeNull();
  });
  it("builds every redirect from a validated slug", () => {
    expect(signInPath("tamilil-sollu")).toBe("/signin?event=tamilil-sollu");
    expect(signInPath(null)).toBe("/signin");
    expect(verifyPath("tamilil-sollu")).toBe("/signin/verify?event=tamilil-sollu");
    expect(verifyPath("tamilil-sollu", true)).toBe("/signin/verify?event=tamilil-sollu&resent=1");
    expect(verifyPath(null, true)).toBe("/signin/verify?resent=1");
    expect(afterSignInPath("tamilil-sollu")).toBe(registerPath("tamilil-sollu"));
    expect(afterSignInPath(null)).toBe("/account");
  });
});

describe("resend cooldown", () => {
  it("counts down from the moment the last code was sent", () => {
    const sent = 1_000_000;
    expect(secondsLeft(sent, sent)).toBe(60);
    expect(secondsLeft(sent, sent + 1)).toBe(60);
    expect(secondsLeft(sent, sent + 30_000)).toBe(30);
    expect(secondsLeft(sent, sent + COOLDOWN_MS)).toBe(0);
    expect(secondsLeft(sent, sent + COOLDOWN_MS + 5_000)).toBe(0);
  });
});

describe("auth error messages", () => {
  it("send: rate limits and invalid emails get specific text, anything else a generic failure", () => {
    expect(sendErrorMessage({ code: "over_email_send_rate_limit" })).toBe(copy.errors.tooMany);
    expect(sendErrorMessage({ status: 429 })).toBe(copy.errors.tooMany);
    expect(sendErrorMessage({ code: "email_address_invalid" })).toBe(copy.errors.emailNotAccepted); // well formed, but refused by Supabase: not "enter a valid email"
    expect(sendErrorMessage({ code: "unexpected_failure", message: "smtp exploded for a@b.com" })).toBe(copy.errors.sendFailed);
  });
  it("verify: wrong and expired codes share one message; limits and bans are distinct", () => {
    expect(verifyErrorMessage({ code: "otp_expired" })).toBe(copy.errors.wrongOrExpired);
    expect(verifyErrorMessage({ status: 403, message: "Token has expired or is invalid" })).toBe(copy.errors.wrongOrExpired);
    expect(verifyErrorMessage({ code: "over_request_rate_limit" })).toBe(copy.errors.tooMany);
    expect(verifyErrorMessage({ code: "user_banned" })).toBe(copy.errors.signInFailed);
    expect(verifyErrorMessage({ status: 500 })).toBe(copy.errors.signInFailed);
  });
  it("never reveals whether an email has an account", () => {
    const everything = JSON.stringify(copy.errors);
    expect(everything).not.toMatch(/not registered|no account|already (registered|exists)|user not found/i);
  });
  it("never echoes the provider's raw message", () => {
    const m = JSON.stringify([sendErrorMessage({ message: "secret@leak.test failed" }), verifyErrorMessage({ message: "secret@leak.test failed", status: 500 })]);
    expect(m).not.toContain("secret@leak.test");
  });
});

describe("rate limiter", () => {
  it("allows up to the limit, then blocks until the window ends", () => {
    let t = 0;
    const limiter = createLimiter(3, 1000, () => t);
    expect([1, 2, 3].map(() => limiter.hit("k").allowed)).toEqual([true, true, true]);
    const blocked = limiter.hit("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(1000);
    t = 999;
    expect(limiter.hit("k").allowed).toBe(false);
    t = 1000;
    expect(limiter.hit("k").allowed).toBe(true);
  });
  it("counts keys separately and can reset one", () => {
    const limiter = createLimiter(1, 1000, () => 0);
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("b").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(false);
    limiter.reset("a");
    expect(limiter.hit("a").allowed).toBe(true);
  });
});

describe("maskEmail", () => {
  it("keeps the first letter and the domain only", () => {
    expect(maskEmail("jane.doe@example.com")).toBe("j•••@example.com");
    expect(maskEmail("x")).toBe("•••");
  });
});
