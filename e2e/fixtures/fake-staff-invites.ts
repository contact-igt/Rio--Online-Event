// Stands in for lib/staff/invites.ts in the offline admin tests: the readiness and the e-mail lookup come from the window. No Auth call exists.
declare global {
  interface Window {
    __path?: string;
    __invite?: { enabled: boolean; secretKey: "ok" | "missing" | "badFormat"; ready: boolean };
    __authInfo?: Record<string, { email: string | null; lastSignInAt: string | null }> | null;
  }
}

export function inviteReadiness() {
  return window.__invite ?? { enabled: false, secretKey: "missing" as const, ready: false };
}

export function createAuthLookup() {
  return async (ids: string[]) => (window.__authInfo ? new Map(ids.map((id) => [id, window.__authInfo![id] ?? { email: null, lastSignInAt: null }])) : null);
}
