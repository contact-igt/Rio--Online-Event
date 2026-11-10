// Which Supabase project the app may talk to. Fail closed: the app refuses to start auth unless the
// project in NEXT_PUBLIC_SUPABASE_URL is the one declared in RIO_SUPABASE_ALLOWED_REF. A stray
// production .env therefore cannot be used by accident. Error messages are fixed strings (no values).

const REF = /^[a-z0-9]{20}$/;

export class SupabaseConfigError extends Error {
  override name = "SupabaseConfigError";
}

// By name, not instanceof: the check still works if the module is loaded twice (separate bundles, test reloads).
export const isSupabaseConfigError = (e: unknown): boolean => e instanceof Error && e.name === "SupabaseConfigError";

export type SupabaseConfig = { url: string; publishableKey: string; ref: string };
type Env = Record<string, string | undefined>;

function keyIsPublishable(key: string): boolean {
  if (key.startsWith("sb_publishable_")) return true;
  if (!key.startsWith("eyJ")) return false;
  try {
    const payload = key.split(".")[1] ?? "";
    return (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { role?: string }).role === "anon";
  } catch {
    return false;
  }
}

export function resolveSupabaseConfig(env: Env): SupabaseConfig {
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
  const allowed = env.RIO_SUPABASE_ALLOWED_REF ?? "";

  if (!url || !publishableKey) throw new SupabaseConfigError("Supabase URL or publishable key is not configured.");
  if (!keyIsPublishable(publishableKey)) throw new SupabaseConfigError("The configured Supabase key is not a publishable key.");
  if (!allowed) throw new SupabaseConfigError("RIO_SUPABASE_ALLOWED_REF is not set; refusing to choose a Supabase project.");

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new SupabaseConfigError("NEXT_PUBLIC_SUPABASE_URL is not a valid URL.");
  }
  if (host === "127.0.0.1" || host === "localhost") {
    if (allowed !== "local") throw new SupabaseConfigError("A local Supabase URL needs RIO_SUPABASE_ALLOWED_REF=local.");
    return { url, publishableKey, ref: "local" };
  }
  const ref = host.endsWith(".supabase.co") ? (host.split(".")[0] ?? "") : "";
  if (!REF.test(ref)) throw new SupabaseConfigError("NEXT_PUBLIC_SUPABASE_URL must be a *.supabase.co project URL.");
  if (ref !== allowed) throw new SupabaseConfigError("The configured Supabase project is not the allowed project; refusing.");
  return { url, publishableKey, ref };
}

export function getSupabaseConfig(): SupabaseConfig {
  return resolveSupabaseConfig(process.env);
}
