import { describe, expect, it } from "vitest";
import { assertOtpLength, describeVerifyFailure } from "./live-code.ts";

describe("assertOtpLength", () => {
  it("passes a code of the expected length through unchanged, leading zero included", () => {
    expect(assertOtpLength("048392", 6)).toBe("048392");
    expect(assertOtpLength("04839201", 8)).toBe("04839201");
  });

  it("rejects other lengths and non-digits, naming the lengths but never the code", () => {
    for (const [bad, expected] of [["", 6], ["12345", 6], ["48392011", 6], ["483920", 8], ["4839201122", 8], ["12ab56", 6]] as const) {
      let message = "";
      try {
        assertOtpLength(bad, expected);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, bad).toContain(`${bad.length}-character`);
      expect(message, bad).toContain(`exactly ${expected} digits`);
      if (bad.length >= 4) expect(message.includes(bad), bad).toBe(false);
    }
  });
});

describe("describeVerifyFailure", () => {
  it("tells server-side shape validation apart from Supabase Auth, at any configured length", () => {
    expect(describeVerifyFailure("Enter the 6-digit code.", 8)).toMatch(/server-side validation.*8 characters.*Supabase Auth was not asked/);
    expect(describeVerifyFailure("Enter the 8-digit code.", 6)).toMatch(/server-side validation.*6 characters/);
    expect(describeVerifyFailure("That code is wrong or has expired. Check it, or send a new code.", 8)).toMatch(/Supabase Auth refused/);
    expect(describeVerifyFailure("Too many attempts. Wait a few minutes and try again.", 8)).toMatch(/rate-limited/);
  });
});
