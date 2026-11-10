import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { resolveSupabaseConfig } from "./config";

// Shared by the website and the admin panel, which each export it as their own proxy with their own route list.
// Keeps a signed-in parent's session fresh. It only refreshes tokens and writes the refreshed cookies;
// it never grants or denies access. Each protected page checks the session itself (lib/auth/session.ts),
// as the Next.js docs advise against relying on the proxy for authorization.
export async function refreshSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  let config;
  try {
    config = resolveSupabaseConfig(process.env);
  } catch {
    return response; // the pages report the configuration problem
  }

  const supabase = createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(toSet, headers) {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
      },
    },
  });

  await supabase.auth.getClaims();
  return response;
}
