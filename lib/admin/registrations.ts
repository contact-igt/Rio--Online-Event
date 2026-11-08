import type { SupabaseClient } from "@supabase/supabase-js";
import { events } from "@/lib/events";

// What the administrator's Registrations screens show. Everything comes from the `submissions` table read with the ADMINISTRATOR'S OWN
// session: row level security returns every row to an administrator and nothing at all to a judge (there is deliberately no judge policy),
// so a judge or a parent who somehow reached this code would get an empty list, not personal data. The pages also check the role first.
//
// A DRAFT is never counted or shown as a completed submission: only status "finalized" is. A video counts as verified when the entry has
// moved past "draft": the status becomes "uploaded" only after the server has checked the stored object against what was declared
// (see attach_video_upload in migration 00500). The video's private storage key is read but reduced to a yes/no here and never returned.

export type RegStatus = "draft" | "uploaded" | "finalized" | "withdrawn";

export type Registration = {
  id: string;
  entryCode: string;
  eventId: number;
  status: RegStatus;
  childName: string;
  childAge: number;
  parentName: string;
  parentEmail: string;
  parentMobile: string;
  consentVersion: string;
  consentAt: string | null;
  mediaConsent: boolean | null;
  hasVideo: boolean;
  createdAt: string;
  updatedAt: string | null;
  finalizedAt: string | null;
  withdrawnAt: string | null;
};

const COLUMNS = "id, entry_code, event_id, status, child_name, child_age, parent_name, parent_email, parent_mobile, consent_version, consent_at, media_consent, video_key, created_at, updated_at, finalized_at, withdrawn_at";

type Row = {
  id: string;
  entry_code: string;
  event_id: number;
  status: RegStatus;
  child_name: string;
  child_age: number;
  parent_name: string;
  parent_email: string;
  parent_mobile: string;
  consent_version: string;
  consent_at: string | null;
  media_consent: boolean | null;
  video_key: string | null;
  created_at: string;
  updated_at: string | null;
  finalized_at: string | null;
  withdrawn_at: string | null;
};

function toRegistration(r: Row): Registration {
  return {
    id: r.id,
    entryCode: r.entry_code,
    eventId: r.event_id,
    status: r.status,
    childName: r.child_name,
    childAge: r.child_age,
    parentName: r.parent_name,
    parentEmail: r.parent_email,
    parentMobile: r.parent_mobile,
    consentVersion: r.consent_version,
    consentAt: r.consent_at,
    mediaConsent: r.media_consent,
    hasVideo: r.video_key !== null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finalizedAt: r.finalized_at,
    withdrawnAt: r.withdrawn_at,
  };
}

export async function loadRegistrations(supabase: SupabaseClient): Promise<Registration[] | null> {
  const { data, error } = await supabase.from("submissions").select(COLUMNS).order("created_at", { ascending: false }).limit(5000);
  if (error) return null;
  return ((data ?? []) as unknown as Row[]).map(toRegistration);
}

export async function loadRegistration(supabase: SupabaseClient, id: string): Promise<Registration | null> {
  const { data, error } = await supabase.from("submissions").select(COLUMNS).eq("id", id).maybeSingle();
  if (error || !data) return null;
  return toRegistration(data as unknown as Row);
}

export type Counts = { total: number; draft: number; awaiting: number; finalized: number; withdrawn: number };

/** Counted from the rows. `awaiting` = video uploaded and verified but not yet submitted. Only `finalized` is a completed submission. */
export function countRegistrations(rows: readonly Registration[]): Counts {
  const n = (s: RegStatus) => rows.filter((r) => r.status === s).length;
  return { total: rows.length, draft: n("draft"), awaiting: n("uploaded"), finalized: n("finalized"), withdrawn: n("withdrawn") };
}

export const statusLabel: Record<RegStatus, string> = {
  draft: "Draft (not submitted)",
  uploaded: "Awaiting final submission",
  finalized: "Finalized",
  withdrawn: "Withdrawn",
};

/** Video status in words. Not a stored column: derived from the status and the presence of the private object reference. */
export function videoLabel(r: Pick<Registration, "status" | "hasVideo">): string {
  if (r.status === "withdrawn") return r.hasVideo ? "Video kept (withdrawn)" : "No video";
  if (!r.hasVideo) return "No video yet";
  return "Uploaded and verified";
}

export const eventName = (id: number) => events.find((e) => e.number === id);

export type Filters = { q: string; status: RegStatus | ""; event: number | null; page: number };
export const PAGE_SIZE = 25;
const STATUSES: readonly RegStatus[] = ["draft", "uploaded", "finalized", "withdrawn"];

/** Reads the address query without trusting it: anything unexpected becomes "no filter". */
export function parseFilters(q: Record<string, string | string[] | undefined>): Filters {
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
  const status = STATUSES.find((s) => s === one(q.status)) ?? "";
  const eventNo = Number(one(q.event));
  const event = Number.isInteger(eventNo) && events.some((e) => e.number === eventNo) ? eventNo : null;
  const page = Math.max(1, Math.min(1000, Number.parseInt(one(q.page), 10) || 1));
  return { q: one(q.q).trim().slice(0, 100), status, event, page };
}

const norm = (s: string) => s.normalize("NFC").toLowerCase();
const digits = (s: string) => s.replace(/\D/g, "");

/** Case-insensitive search over reference, child, parent, e-mail and mobile, plus the status and competition filters. Runs on rows already read. */
export function filterRegistrations(rows: readonly Registration[], f: Pick<Filters, "q" | "status" | "event">): Registration[] {
  const needle = norm(f.q);
  const needleDigits = digits(f.q);
  return rows.filter((r) => {
    if (f.status && r.status !== f.status) return false;
    if (f.event !== null && r.eventId !== f.event) return false;
    if (!needle) return true;
    return (
      norm(r.entryCode).includes(needle) ||
      norm(r.childName).includes(needle) ||
      norm(r.parentName).includes(needle) ||
      norm(r.parentEmail).includes(needle) ||
      (needleDigits.length >= 4 && digits(r.parentMobile).includes(needleDigits))
    );
  });
}

export function paginate<T>(rows: readonly T[], page: number): { items: T[]; pages: number; page: number } {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const p = Math.min(page, pages);
  return { items: rows.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE), pages, page: p };
}
