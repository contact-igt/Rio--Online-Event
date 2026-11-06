import { describe, expect, it } from "vitest";
import { resolveSupabaseConfig, SupabaseConfigError } from "./config";

const DEV = "devdevdevdevdevdevde";
const PROD = "prodprodprodprodprod";
const PUB = "sb_publishable_fakefakefakefake";
const env = (over: Record<string, string | undefined> = {}) => ({
  NEXT_PUBLIC_SUPABASE_URL: `https://${DEV}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUB,
  RIO_SUPABASE_ALLOWED_REF: DEV,
  ...over,
});
const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.sig`;

describe("resolveSupabaseConfig (the app may only talk to the declared project)", () => {
  it("accepts the declared dev project", () => {
    expect(resolveSupabaseConfig(env())).toEqual({ url: `https://${DEV}.supabase.co`, publishableKey: PUB, ref: DEV });
  });

  it("refuses a production URL when the allowed ref is the dev project", () => {
    expect(() => resolveSupabaseConfig(env({ NEXT_PUBLIC_SUPABASE_URL: `https://${PROD}.supabase.co` }))).toThrow(/not the allowed project/);
  });

  it("fails closed when no allowed project is declared (for example only a production .env is present)", () => {
    expect(() => resolveSupabaseConfig(env({ RIO_SUPABASE_ALLOWED_REF: undefined }))).toThrow(/RIO_SUPABASE_ALLOWED_REF/);
    expect(() => resolveSupabaseConfig(env({ RIO_SUPABASE_ALLOWED_REF: "" }))).toThrow(SupabaseConfigError);
  });

  it("refuses missing settings and malformed URLs", () => {
    expect(() => resolveSupabaseConfig(env({ NEXT_PUBLIC_SUPABASE_URL: "" }))).toThrow(SupabaseConfigError);
    expect(() => resolveSupabaseConfig(env({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "" }))).toThrow(SupabaseConfigError);
    expect(() => resolveSupabaseConfig(env({ NEXT_PUBLIC_SUPABASE_URL: "not a url" }))).toThrow(/valid URL/);
    expect(() => resolveSupabaseConfig(env({ NEXT_PUBLIC_SUPABASE_URL: "https://example.com" }))).toThrow(/supabase\.co/);
    expect(() => resolveSupabaseConfig(env({ NEXT_PUBLIC_SUPABASE_URL: `https://${DEV}.supabase.co.evil.example` }))).toThrow(SupabaseConfigError);
  });

  it("never accepts a secret or service-level key as the public key", () => {
    expect(() => resolveSupabaseConfig(env({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_fakefakefakefake" }))).toThrow(/publishable/);
    expect(() => resolveSupabaseConfig(env({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt("service_role") }))).toThrow(/publishable/);
    expect(resolveSupabaseConfig(env({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt("anon") })).ref).toBe(DEV);
  });

  it("allows a local stack only when explicitly declared", () => {
    const local = env({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", RIO_SUPABASE_ALLOWED_REF: "local" });
    expect(resolveSupabaseConfig(local).ref).toBe("local");
    expect(() => resolveSupabaseConfig(env({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }))).toThrow(/local/);
  });

  it("error messages never contain the configured values", () => {
    for (const bad of [env({ NEXT_PUBLIC_SUPABASE_URL: `https://${PROD}.supabase.co` }), env({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_fakefakefakefake" })]) {
      let message = "";
      try {
        resolveSupabaseConfig(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      for (const leak of [DEV, PROD, PUB, "sb_secret_fakefakefakefake"]) expect(message).not.toContain(leak);
    }
  });
});
