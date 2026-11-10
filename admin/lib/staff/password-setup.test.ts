import { describe, expect, it } from "vitest";
import { parsePasswordChange, passwordErrorCode } from "./password-setup";

describe("parsePasswordChange", () => {
  it("returns the two passwords the API wants", () => {
    expect(parsePasswordChange({ current: "old-pass", password: "new-password-123", confirm: "new-password-123" })).toEqual({ currentPassword: "old-pass", newPassword: "new-password-123" });
  });
  it("refuses a missing field and a mismatch", () => {
    expect(parsePasswordChange({ current: "", password: "x", confirm: "x" })).toBe("invalid");
    expect(parsePasswordChange({ current: "a", password: null, confirm: "x" })).toBe("invalid");
    expect(parsePasswordChange({ current: "a", password: "one-long-password", confirm: "other-long-password" })).toBe("mismatch");
  });
});

describe("passwordErrorCode", () => {
  it.each([
    [422, "weak_password", "weak"],
    [403, "current_password_incorrect", "current"],
    [429, undefined, "tooMany"],
    [400, "invalid_request", "invalid"],
    [403, "csrf_invalid", "unavailable"],
    [0, undefined, "unavailable"],
  ])("maps %i %s to %s", (status, code, expected) => {
    expect(passwordErrorCode(status, code)).toBe(expected);
  });
});
