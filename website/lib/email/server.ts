import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { emailAvailable, readEmailConfig } from "./config";
import { queueParticipationEmail, type Claimed, type EmailDeps, type OutboxDb } from "./outbox";
import { createResendProvider } from "./provider";

// Wires the confirmation e-mail to the real database functions and the configured provider. Server-only (it uses the service-role client,
// after the caller has already identified the parent). With RIO_EMAIL_ENABLED off, or the provider not configured, nothing is ever sent:
// the intention is still recorded in the outbox (when the outbox exists) so a confirmation can go out later.

export function createOutboxDb(admin: SupabaseClient): OutboxDb {
  const fail = (message: string) => new Error(message.includes("not_finalized") ? "not_finalized" : "database");
  return {
    async enqueue(submissionId) {
      const { data, error } = await admin.rpc("enqueue_participation_email", { p_submission: submissionId });
      if (error || typeof data !== "string") throw fail(error?.message ?? "");
      return data;
    },
    async claim(id) {
      const { data, error } = await admin.rpc("claim_participation_email", { p_id: id });
      if (error) throw fail(error.message);
      const row = (data as { parent_email: string; entry_code: string; event_id: number; attempt: number }[] | null)?.[0];
      return row ? ({ to: row.parent_email, reference: row.entry_code, eventId: Number(row.event_id), attempt: Number(row.attempt) } satisfies Claimed) : null;
    },
    async finish(id, outcome) {
      const { error } = await admin.rpc("finish_participation_email", { p_id: id, p_outcome: outcome });
      if (error) throw fail(error.message);
    },
    async due(limit) {
      const { data, error } = await admin.rpc("due_participation_emails", { p_limit: limit });
      if (error) throw fail(error.message);
      return Array.isArray(data) ? (data as string[]) : [];
    },
  };
}

/** The database side always; the provider only when sending is switched on AND configured. */
export function createEmailDeps(): EmailDeps {
  const cfg = emailAvailable() ? readEmailConfig() : null;
  return { db: createOutboxDb(createAdminClient()), provider: cfg ? createResendProvider(cfg) : null };
}

/** Called after a successful final submission. Never throws. */
export async function queueConfirmation(submissionId: string): Promise<void> {
  try {
    await queueParticipationEmail(createEmailDeps(), submissionId);
  } catch {
    // an e-mail problem must never touch the submission
  }
}
