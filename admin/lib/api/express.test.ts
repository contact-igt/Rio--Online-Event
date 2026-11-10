import { describe, expect, it } from "vitest";
import { parseSetCookie } from "./express";

describe("parseSetCookie", () => {
  it("reads the attributes the API sets", () => {
    expect(parseSetCookie("rio_staff=abc123; Max-Age=28800; Path=/; HttpOnly; SameSite=Strict")).toEqual({ name: "rio_staff", value: "abc123", maxAge: 28800, httpOnly: true, secure: false, sameSite: "strict", path: "/" });
    expect(parseSetCookie("__Host-rio_staff=x; Path=/; Secure; HttpOnly; SameSite=Lax")).toMatchObject({ secure: true, sameSite: "lax" });
  });
  it("understands a clearing cookie", () => {
    expect(parseSetCookie("rio_staff=; Max-Age=0; Path=/")).toMatchObject({ value: "", maxAge: 0 });
    expect(parseSetCookie("rio_staff=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/")!.maxAge).toBeLessThan(0);
  });
  it("refuses a header with no name", () => {
    expect(parseSetCookie("=x")).toBeNull();
    expect(parseSetCookie("")).toBeNull();
  });
});
