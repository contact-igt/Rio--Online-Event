import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseConfig } from "./config";

// Server-side Supabase client with cookie-based sessions. Server Components, Server Actions and Route
// Handlers only. There is deliberately no browser client: the one-time code is verified on the server, so
// session tokens never need to be handled by client JavaScript, and the CSP keeps connect-src at 'self'.
export async function createClient() {
  const { url, publishableKey } = getSupabaseConfig();
  const cookieStore = await cookies();
  return createServerClient(url, publishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(toSet) {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // A Server Component cannot set cookies. proxy.ts refreshes the session on the routes that matter.
        }
      },
    },
  });
}
