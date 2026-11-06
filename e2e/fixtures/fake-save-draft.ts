// Stands in for app/events/[slug]/register/actions.ts in the offline form test. It runs the REAL validation
// (parseRegistration) and returns the same state shapes as the real action, so the form behaves as it does in the app.
// Two child names trigger the database-level answers the real action gives: a duplicate and a save failure.

import { getEvent } from "@/lib/events";
import { reg } from "@/lib/registration/messages";
import { parseRegistration, pickFields } from "@/lib/registration/schemas";
import type { SaveState } from "@/app/events/[slug]/register/actions";

declare global {
  interface Window {
    __saved: Record<string, string>[];
  }
}

export async function saveDraft(_prev: SaveState, formData: FormData): Promise<SaveState> {
  const raw = pickFields(formData);
  const event = getEvent(raw.event ?? "")!;
  const parsed = parseRegistration(event, raw, !raw.draftId);
  if (!parsed.ok) return { error: reg.errors.fix, fieldErrors: parsed.errors, values: raw };
  if (raw.childName === "Duplicate Dee") return { error: reg.errors.duplicate, duplicateId: "x", values: raw };
  if (raw.childName === "Failing Fay") return { error: reg.errors.saveFailed, values: raw };
  (window.__saved ??= []).push(raw); // the real action would insert the row and redirect
  return undefined;
}
