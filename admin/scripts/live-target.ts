// The guard that decides which Supabase project a live test or database command may touch. Plain TypeScript with no
// ESM-only syntax, so it loads from Node (scripts/db-dev.ts), Vitest and Playwright alike.
// Rules: the project in .env is production and is always refused; a hosted target needs RIO_LIVE_URL,
// RIO_DEV_PROJECT_REF and RIO_LIVE_CONFIRM to agree; keys are only checked by shape and never printed.

import { existsSync, readFileSync } from "node:fs";

export const REF = /^[a-z0-9]{20}$/;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

export type Env = Record<string, string | undefined>;

export class GuardError extends Error {}

export function projectRefFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    const ref = host.split(".")[0] ?? "";
    return host.endsWith(".supabase.co") && REF.test(ref) ? ref : null;
  } catch {
    return null;
  }
}

/** The project in .env is production for this repository. */
export function readProductionRef(envFile = ".env"): string | null {
  if (!existsSync(envFile)) return null;
  const line = readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_URL="));
  return line ? projectRefFromUrl(line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")) : null;
}

export type LiveTarget = { url: string; publishableKey: string; secretKey: string; ref: string | "local" };

/** publishable (anon-level) or secret (service-level) by prefix, or by the role claim of a legacy JWT key. */
export function keyKind(key: string): "publishable" | "secret" | "unknown" {
  if (key.startsWith("sb_publishable_")) return "publishable";
  if (key.startsWith("sb_secret_")) return "secret";
  if (key.startsWith("eyJ")) {
    try {
      const payload = key.split(".")[1] ?? "";
      const role = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { role?: string }).role;
      return role === "anon" ? "publishable" : role === "service_role" ? "secret" : "unknown";
    } catch {
      return "unknown";
    }
  }
  return "unknown";
}

/**
 * Where the live Auth-session tests may run: a local stack, or the DEV project that is not production.
 * For a hosted target three independent declarations must agree: RIO_LIVE_URL, RIO_DEV_PROJECT_REF and
 * RIO_LIVE_CONFIRM. Keys are only checked by shape and role claim; they are never printed.
 */
export function assertSafeLiveTarget(env: Env, prodRef: string | null, prodPublishableKey: string | null = null): LiveTarget {
  const url = env.RIO_LIVE_URL ?? "";
  const publishableKey = env.RIO_LIVE_PUBLISHABLE_KEY ?? "";
  const secretKey = env.RIO_LIVE_SECRET_KEY ?? "";
  if (!url || !publishableKey || !secretKey) {
    throw new GuardError("Live tests need RIO_LIVE_URL, RIO_LIVE_PUBLISHABLE_KEY and RIO_LIVE_SECRET_KEY (dev project or local stack).");
  }
  if (keyKind(publishableKey) !== "publishable") throw new GuardError("RIO_LIVE_PUBLISHABLE_KEY is not a publishable (anon-level) key.");
  if (keyKind(secretKey) !== "secret") throw new GuardError("RIO_LIVE_SECRET_KEY is not a secret (service-level) key.");
  if (prodPublishableKey && publishableKey === prodPublishableKey) throw new GuardError("RIO_LIVE_PUBLISHABLE_KEY is the production key from .env. Refusing.");
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new GuardError("RIO_LIVE_URL is not a valid URL.");
  }
  if (LOCAL_HOSTS.has(host)) return { url, publishableKey, secretKey, ref: "local" };
  const ref = projectRefFromUrl(url);
  if (!ref) throw new GuardError("RIO_LIVE_URL must be a *.supabase.co project URL or a local stack.");
  if (prodRef && ref === prodRef) throw new GuardError("RIO_LIVE_URL is the production project from .env. Refusing.");
  if (env.RIO_DEV_PROJECT_REF !== ref) throw new GuardError("RIO_LIVE_URL does not match RIO_DEV_PROJECT_REF.");
  if (env.RIO_LIVE_CONFIRM !== ref) throw new GuardError("Set RIO_LIVE_CONFIRM to the dev project ref to allow tests that write test data.");
  return { url, publishableKey, secretKey, ref };
}

/** The production publishable key from .env, used only to refuse it as a live-test key. */
export function readProductionPublishableKey(envFile = ".env"): string | null {
  if (!existsSync(envFile)) return null;
  const line = readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="));
  return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") || null : null;
}
