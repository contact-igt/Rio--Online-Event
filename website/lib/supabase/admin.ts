import { createClient } from "@supabase/supabase-js";
import { getSupabaseConfig, SupabaseConfigError } from "./config.ts";

// A Supabase client that uses the SECRET key. Server-only, and used for exactly one purpose: calling the
// service_role-only upload functions after the signed-in parent has been identified from their own session. It must
// never be created in a client component, and it is never used to read or write a parent's data on their behalf.
// It talks only to the project allowed by RIO_SUPABASE_ALLOWED_REF, like every other client in the app.

function isServiceRoleJwt(key: string): boolean {
  if (!key.startsWith("eyJ")) return false;
  try {
    return (JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString("utf8")) as { role?: string }).role === "service_role";
  } catch {
    return false;
  }
}

/** ok / missing / badFormat for SUPABASE_SECRET_KEY, judged by shape only. The value is never returned. */
export function secretKeyStatus(env: Record<string, string | undefined> = process.env): "ok" | "missing" | "badFormat" {
  const key = env.SUPABASE_SECRET_KEY?.trim() ?? "";
  if (key === "") return "missing";
  return key.startsWith("sb_secret_") || isServiceRoleJwt(key) ? "ok" : "badFormat";
}

export function createAdminClient() {
  const { url } = getSupabaseConfig(); // applies the allowed-project check
  if (secretKeyStatus() !== "ok") throw new SupabaseConfigError("SUPABASE_SECRET_KEY is missing or is not a secret key.");
  return createClient(url, process.env.SUPABASE_SECRET_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
}
