"use server";

import { after } from "next/server";
import { createLimiter } from "@/lib/auth/rate-limit";
import { queueConfirmation } from "@/lib/email/server";
import { getEvent } from "@/lib/events";
import { createFinalizeDeps, finalizeAvailable } from "@/lib/submit/server";
import { finalizeEntry, type FinalizeFailure, type Finalized } from "@/lib/submit/service";
import { createClient } from "@/lib/supabase/server";

// Final submission of an entry. The parent is identified from their own signed-in session, never from the form. The switch is
// the very first statement, so with it off nothing else runs (not even a session lookup). Nothing here logs, and no result
// contains an object key, an ETag, a URL, a secret or any child detail.

const submitByUser = createLimiter(5, 10 * 60_000);

async function parent(): Promise<string | null> {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser(); // verified with Supabase, not just read from the cookie
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

export async function submitEntry(input: { submissionId: string; slug: string }): Promise<Finalized | FinalizeFailure> {
  if (!finalizeAvailable()) return { ok: false, code: "unavailable" }; // switched off or not configured: nothing else runs
  const owner = await parent();
  if (!owner) return { ok: false, code: "notFound" };
  const event = typeof input?.slug === "string" ? getEvent(input.slug) : undefined;
  if (!event) return { ok: false, code: "notFound" };
  if (!submitByUser.hit(owner).allowed) return { ok: false, code: "tooMany" };
  try {
    const result = await finalizeEntry(createFinalizeDeps(), { ownerId: owner, submissionId: input?.submissionId, eventId: event.number });
    // The entry is final at this point. The confirmation e-mail is queued AFTER the response (so it never slows or changes it); only the
    // request that made the transition queues it, a repeat does not, and any failure inside is swallowed by queueConfirmation.
    if (result.ok && !result.already) after(() => queueConfirmation(input.submissionId));
    return result;
  } catch {
    return { ok: false, code: "unavailable" };
  }
}
