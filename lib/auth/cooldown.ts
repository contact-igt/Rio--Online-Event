// Pure (no server APIs), so both the server actions and the client countdown use the same rule.

export const COOLDOWN_MS = 60_000; // matches Supabase's default minimum interval between codes for one user

/** Seconds until another code may be requested; 0 when allowed. */
export function secondsLeft(sentAt: number, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((sentAt + COOLDOWN_MS - now) / 1000));
}
