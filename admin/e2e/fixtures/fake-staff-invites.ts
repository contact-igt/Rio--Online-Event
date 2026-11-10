// Stands in for lib/staff/invites.ts in the offline admin tests: the e-mail lookup comes from the window. No Auth call exists.
declare global {
  interface Window {
    __path?: string;
    __authInfo?: Record<string, { email: string | null; lastSignInAt: string | null; mustChangePassword?: boolean }> | null;
  }
}

export function createAuthLookup() {
  return async (ids: string[]) => (window.__authInfo ? new Map(ids.map((id) => [id, window.__authInfo![id] ?? { email: null, lastSignInAt: null }])) : null);
}
