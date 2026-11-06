"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { registerPath, signInPath } from "@/lib/auth/paths";
import { createLimiter } from "@/lib/auth/rate-limit";
import { parseEventSlug } from "@/lib/auth/schemas";
import { getEvent } from "@/lib/events";
import { getConsentCopy } from "@/lib/registration/consent";
import { listOwnRegistrations, MAX_REGISTRATIONS_PER_PARENT } from "@/lib/registration/drafts";
import { findConflicts } from "@/lib/registration/duplicates";
import { registrationWriteError } from "@/lib/registration/errors";
import { reg, type Msg } from "@/lib/registration/messages";
import { draftIdSchema, parseRegistration, pickFields, type FieldErrors } from "@/lib/registration/schemas";
import { isRegistrationOpen, loadSettings } from "@/lib/registration/settings";
import { createClient } from "@/lib/supabase/server";

// Saves a registration DRAFT through the signed-in parent's own Supabase session, so row level security decides
// what is allowed. The owner is never read from the form: the database fills it from the session (auth.uid()).
// The verified email comes from the session, not the form. Nothing here logs or returns submitted personal data
// beyond echoing the parent's own input back into their own form.

export type SaveState = { error?: Msg; fieldErrors?: FieldErrors; duplicateId?: string; values?: Record<string, string> } | undefined;

const saveByUser = createLimiter(20, 10 * 60_000);

export async function saveDraft(_prev: SaveState, formData: FormData): Promise<SaveState> {
  const raw = pickFields(formData);
  const slug = parseEventSlug(raw.event);
  const event = slug ? getEvent(slug) : undefined;
  if (!event) return { error: reg.errors.notFound };

  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
  } catch {
    return { error: reg.errors.unavailable, values: raw };
  }

  // an expired or revoked session must not fail silently: send the parent back to sign in
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user?.email) redirect(signInPath(event.slug, true));

  if (!saveByUser.hit(user.id).allowed) return { error: reg.errors.tooMany, values: raw };

  const settings = await loadSettings(supabase);
  if (!isRegistrationOpen(settings) || !settings) return { error: reg.errors.closed, values: raw };
  const consent = getConsentCopy(settings.consentVersion);
  if (!consent) return { error: reg.errors.closed, values: raw };

  const parsedId = raw.draftId ? draftIdSchema.safeParse(raw.draftId) : null;
  if (parsedId && !parsedId.success) return { error: reg.errors.notFound, values: raw };
  const editing = parsedId?.success ? parsedId.data : null;

  // the parent must have agreed to the wording that is current NOW (it may have changed while the form was open)
  if (!editing && raw.consentVersion !== consent.version) {
    revalidatePath(registerPath(event.slug));
    return { error: reg.errors.consentChanged, values: { ...raw, guardianConsent: "", mediaConsent: raw.mediaConsent ?? "" } };
  }

  const parsed = parseRegistration(event, raw, !editing);
  if (!parsed.ok) return { error: reg.errors.fix, fieldErrors: parsed.errors, values: raw };
  const { data } = parsed;

  const own = await listOwnRegistrations(supabase);
  if (!own) return { error: reg.errors.saveFailed, values: raw };

  const conflicts = findConflicts(own, { eventId: event.number, childName: data.childName, mobile: data.mobile }, editing ?? undefined);
  if (conflicts.finalizedElsewhere) return { error: reg.errors.submittedElsewhere, values: raw };
  if (conflicts.sameEvent) return { error: reg.errors.duplicate, duplicateId: conflicts.sameEvent.id, values: raw };

  let id: string;
  if (editing) {
    const existing = own.find((r) => r.id === editing && r.event_id === event.number);
    if (!existing) return { error: reg.errors.notFound, values: raw };
    if (existing.status !== "draft") return { error: reg.errors.locked, values: raw };
    const { data: rows, error } = await supabase
      .from("submissions")
      .update({ child_name: data.childName, child_age: data.childAge, parent_name: data.parentName, parent_mobile: data.mobile, media_consent: data.mediaConsent })
      .eq("id", editing)
      .select("id");
    if (error) return { ...registrationWriteError(error, event), values: raw };
    if (!rows || rows.length === 0) return { error: reg.errors.notFound, values: raw }; // not the parent's row (RLS)
    id = editing;
  } else {
    if (own.filter((r) => r.status !== "withdrawn").length >= MAX_REGISTRATIONS_PER_PARENT) return { error: reg.errors.limit, values: raw };
    const { data: row, error } = await supabase
      .from("submissions")
      .insert({
        event_id: event.number,
        child_name: data.childName,
        child_age: data.childAge,
        parent_name: data.parentName,
        parent_email: user.email.toLowerCase(), // the verified email from the session, never from the form
        parent_mobile: data.mobile,
        consent_version: consent.version,
        media_consent: data.mediaConsent,
      })
      .select("id")
      .single();
    if (error || !row) return { ...registrationWriteError(error ?? {}, event), values: raw };
    id = row.id;
  }

  redirect(`${registerPath(event.slug)}?draft=${id}&saved=1`);
}
