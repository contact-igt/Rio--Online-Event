// Stands in for the server-side modules the registration page reads, so the REAL page can be rendered in the offline browser tests.
// Everything comes from window.__reg: { rows, open, email }. Nothing here is part of the app.

type Reg = { rows: Record<string, unknown>[]; open: boolean; email: boolean; uploads: boolean; finalize: boolean };

declare global {
  interface Window {
    __reg: Reg;
  }
}

export async function requireParent() {
  return { email: "parent.test@example.test" };
}
export async function createClient() {
  return {};
}
export async function loadSettings() {
  return { opensAt: "x", closesAt: "y", consentVersion: "v0-provisional" };
}
export const isRegistrationOpen = () => window.__reg.open;
export async function listOwnRegistrations() {
  return window.__reg.rows;
}
export const emailEnabled = () => window.__reg.email;
export async function signOut() {}

// Mirrors uploadStep and submitStep in lib/upload/server.ts and lib/submit/server.ts, with the two switches taken from window.__reg.
export function uploadStep(input: { open: boolean; current: { id: string; status: string } | null }) {
  const { open, current } = input;
  if (!open || !current || !window.__reg.uploads) return { kind: "off" as const };
  if (current.status !== "draft" && current.status !== "uploaded") return { kind: "off" as const };
  return { kind: "on" as const, submissionId: current.id, hasVideo: current.status === "uploaded" };
}
export function submitStep(input: { open: boolean; current: { id: string; status: string; childName: string; childAge: number; mediaConsent: boolean } | null; event: { slug: string; nameTa: string; nameEn: string } }) {
  const { open, current, event } = input;
  if (!open || !current || current.status !== "uploaded" || !window.__reg.finalize) return { kind: "off" as const };
  return { kind: "on" as const, submissionId: current.id, slug: event.slug, childName: current.childName, childAge: current.childAge, eventNameTa: event.nameTa, eventNameEn: event.nameEn, mediaConsent: current.mediaConsent };
}
