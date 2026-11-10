import { describe, expect, it } from "vitest";
import { secretKeyStatus } from "./admin";

const jwt = (payload: object) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

describe("secretKeyStatus (shape only; the value is never returned)", () => {
  it("accepts a new-style secret key and a legacy service_role key", () => {
    expect(secretKeyStatus({ SUPABASE_SECRET_KEY: "sb_secret_abcdefghijklmnop" })).toBe("ok");
    expect(secretKeyStatus({ SUPABASE_SECRET_KEY: `  ${jwt({ role: "service_role" })}\n` })).toBe("ok");
  });

  it("refuses a missing key, a publishable key, an anon key and anything else", () => {
    expect(secretKeyStatus({})).toBe("missing");
    expect(secretKeyStatus({ SUPABASE_SECRET_KEY: "   " })).toBe("missing");
    expect(secretKeyStatus({ SUPABASE_SECRET_KEY: "sb_publishable_abcdefghijklmnop" })).toBe("badFormat");
    expect(secretKeyStatus({ SUPABASE_SECRET_KEY: jwt({ role: "anon" }) })).toBe("badFormat");
    expect(secretKeyStatus({ SUPABASE_SECRET_KEY: "eyJnotajwt" })).toBe("badFormat");
    expect(secretKeyStatus({ SUPABASE_SECRET_KEY: "random-string" })).toBe("badFormat");
  });

  it("the answer is one of three words and never contains the key", () => {
    const key = "sb_secret_theValueMustNeverAppear";
    expect(secretKeyStatus({ SUPABASE_SECRET_KEY: key })).not.toContain("theValue");
  });
});
