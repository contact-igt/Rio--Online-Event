import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "./proxy";

const call = (path: string, cookie?: string) => proxy(new NextRequest(`http://localhost:3001${path}`, cookie ? { headers: { cookie } } : undefined));

describe("admin proxy", () => {
  it("runs on the staff routes only", () => {
    expect(config.matcher).toEqual(["/admin/:path*", "/judge/:path*", "/staff/:path*"]);
  });
  it.each(["/admin", "/admin/judges", "/judge", "/judge/entries/1"])("sends an anonymous visitor from %s to the sign-in", (path) => {
    const res = call(path);
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/staff/login");
  });
  it("lets the sign-in pages through without a cookie, and a guarded page through with one (the page then asks the API)", () => {
    expect(call("/staff/login").headers.get("location")).toBeNull();
    expect(call("/admin", "rio_staff=abc").headers.get("location")).toBeNull();
    expect(call("/admin", "other=abc").status).toBe(307);
  });
  it("is never cached", () => {
    expect(call("/staff/login").headers.get("cache-control")).toBe("no-store");
  });
});
