import { normalizeMobile } from "./schemas";

// Advisory duplicate checks over the parent's OWN registrations (row level security shows nothing else).
// The database is the authority: it allows one finalized entry per normalized mobile + child name across ALL
// parents (a partial unique index), and enforces it again at finalization in M4. These checks only give the
// parent a clear message early, using the same normalization as the database.

export type OwnSubmission = {
  id: string;
  event_id: number;
  child_name: string;
  parent_mobile: string;
  status: string;
};

/** Same rule as the database's child_name_norm: Unicode NFC, lower case, spaces and . , ' ’ ‘ ` ´ _ - removed. */
export function normalizeChildName(name: string): string {
  return name.normalize("NFC").toLowerCase().replace(/[\s.,'’‘`´_-]+/g, "");
}

/** Last ten digits of the mobile, like the database's parent_phone_norm. */
export function mobileKey(mobile: string): string {
  return (normalizeMobile(mobile) ?? mobile.replace(/\D/g, "")).slice(-10);
}

const sameChild = (a: { name: string; mobile: string }, b: { name: string; mobile: string }) =>
  normalizeChildName(a.name) === normalizeChildName(b.name) && mobileKey(a.mobile) === mobileKey(b.mobile);

export type Conflicts = {
  /** A live registration for the same child in the same competition (block: open it instead). */
  sameEvent: OwnSubmission | null;
  /** The same child already has a finalized entry in another competition (block). */
  finalizedElsewhere: OwnSubmission | null;
  /** The same child has drafts in other competitions (allowed; only one can be finalized later). */
  otherEvents: OwnSubmission[];
};

export function findConflicts(
  existing: OwnSubmission[],
  candidate: { eventId: number; childName: string; mobile: string },
  excludeId?: string,
): Conflicts {
  const matches = existing.filter(
    (s) => s.status !== "withdrawn" && s.id !== excludeId && sameChild({ name: s.child_name, mobile: s.parent_mobile }, { name: candidate.childName, mobile: candidate.mobile }),
  );
  return {
    sameEvent: matches.find((s) => s.event_id === candidate.eventId) ?? null,
    finalizedElsewhere: matches.find((s) => s.event_id !== candidate.eventId && s.status === "finalized") ?? null,
    otherEvents: matches.filter((s) => s.event_id !== candidate.eventId),
  };
}
