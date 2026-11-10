import { describe, expect, it } from "vitest";
import { loginErrorCode, parseLogin } from "./login";

describe("parseLogin", () => {
  it("normalises the email and keeps the password exactly as typed", () => {
    expect(parseLogin({ email: "  Admin@Rio.Local ", password: " p w " })).toEqual({ email: "admin@rio.local", password: " p w " });
  });
  it.each([[{ email: "", password: "x" }], [{ email: "not-an-email", password: "x" }], [{ email: "a@b.co", password: "" }], [{ email: "a@b.co", password: "x".repeat(257) }], [{ email: null, password: "x" }], [{ email: "a@b.co", password: 5 }]])("refuses %j before anything is sent", (raw) => {
    expect(parseLogin(raw)).toBeNull();
  });
});

describe("loginErrorCode", () => {
  it.each([
    [401, "credentials"],
    [429, "tooMany"],
    [400, "invalid"],
    [422, "invalid"],
    [403, "unavailable"],
    [500, "unavailable"],
    [0, "unavailable"],
  ])("maps %i to %s", (status, code) => {
    expect(loginErrorCode(status)).toBe(code);
  });
});
