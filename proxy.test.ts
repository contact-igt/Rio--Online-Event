import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getClaims: vi.fn(async () => ({ data: null, error: null })),
  options: null as null | { cookies: { getAll: () => { name: string; value: string }[]; setAll: (c: { name: string; value: string; options?: Record<string, unknown> }[], headers?: Record<string, string>) => void } },
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, options: NonNullable<typeof h.options>) => {
    h.options = options;
    return { auth: { getClaims: h.getClaims } };
  },
}));

import { config, proxy } from "./proxy";

const DEV = "devdevdevdevdevdevde";
const saved = { ...process.env };

beforeEach(() => {
  h.getClaims.mockClear();
  h.options = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${DEV}.supabase.co`;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_fakefakefakefake";
  process.env.RIO_SUPABASE_ALLOWED_REF = DEV;
});
afterEach(() => {
  process.env = { ...saved };
});

describe("proxy (session refresh)", () => {
  it("asks Supabase to validate and refresh the session using the request's cookies", async () => {
    const request = new NextRequest("http://localhost/account", { headers: { cookie: "sb-x-auth-token=abc; other=1" } });
    await proxy(request);
    expect(h.getClaims).toHaveBeenCalledTimes(1);
    expect(h.options?.cookies.getAll().map((c) => c.name).sort()).toEqual(["other", "sb-x-auth-token"]);
  });

  it("writes refreshed session cookies and cache headers onto the response, and forwards them to the page", async () => {
    const request = new NextRequest("http://localhost/account", { headers: { cookie: "sb-x-auth-token=old" } });
    h.getClaims.mockImplementationOnce(async () => {
      h.options!.cookies.setAll([{ name: "sb-x-auth-token", value: "refreshed", options: { path: "/", httpOnly: true } }], { "Cache-Control": "private, no-store" });
      return { data: null, error: null };
    });
    const response = await proxy(request);
    expect(response.cookies.get("sb-x-auth-token")?.value).toBe("refreshed");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(request.cookies.get("sb-x-auth-token")?.value).toBe("refreshed");
  });

  it("does nothing, and never calls Supabase, when the project is not the allowed one", async () => {
    process.env.RIO_SUPABASE_ALLOWED_REF = "zzzzzzzzzzzzzzzzzzzz";
    const response = await proxy(new NextRequest("http://localhost/account"));
    expect(h.getClaims).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it("never blocks or redirects: authorization is checked by each page", async () => {
    const response = await proxy(new NextRequest("http://localhost/events/kutti-pesalar/register"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("runs only on the routes that use the session, so the public pages stay static", () => {
    expect(config.matcher).toEqual(["/signin/:path*", "/account", "/events/:slug/register", "/admin/:path*", "/judge/:path*", "/staff/:path*"]);
    for (const path of ["/", "/events/:slug", "/images/:path*"]) expect(config.matcher).not.toContain(path);
  });
});
