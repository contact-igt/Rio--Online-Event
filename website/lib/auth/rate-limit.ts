// Fixed-window limiter, in memory. It slows scripted abuse of the sign-in endpoints, but each server
// instance counts separately (serverless), so it is a first layer only: Supabase enforces its own per-email
// and per-IP limits too. Move to a shared store (for example Redis or a database table) if abuse appears.

export type Limiter = {
  /** Counts one attempt. `allowed` is false once the limit is exceeded in the current window. */
  hit(key: string): { allowed: boolean; retryAfterMs: number };
  reset(key: string): void;
};

export function createLimiter(limit: number, windowMs: number, now: () => number = Date.now): Limiter {
  const entries = new Map<string, { count: number; resetAt: number }>();
  return {
    hit(key) {
      const t = now();
      if (entries.size > 5000) for (const [k, v] of entries) if (v.resetAt <= t) entries.delete(k);
      let entry = entries.get(key);
      if (!entry || entry.resetAt <= t) {
        entry = { count: 0, resetAt: t + windowMs };
        entries.set(key, entry);
      }
      entry.count += 1;
      return { allowed: entry.count <= limit, retryAfterMs: Math.max(0, entry.resetAt - t) };
    },
    reset(key) {
      entries.delete(key);
    },
  };
}

// 10-minute windows. Sending: per IP and per email. Verifying: per IP + email (a code has at least six digits).
export const sendByIp = createLimiter(8, 10 * 60_000);
export const sendByEmail = createLimiter(5, 10 * 60_000);
export const verifyByIpAndEmail = createLimiter(8, 10 * 60_000);
