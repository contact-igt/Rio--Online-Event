import { renderParticipationEmail } from "./template";
import type { EmailProvider } from "./provider";

// Sending the participation confirmation through the outbox. Plain functions with the database and the provider passed in, so the rules can
// be tested with mocks:
//   * queue: record the intention (idempotent: one row per submission), then try once right away if sending is possible;
//   * send: claim the row atomically FIRST (so two requests cannot both send), build the message, hand it to the provider with the row id as
//     idempotency key, and record the outcome: sent, retry later (with a growing delay, at most 8 tries) or never (a permanent refusal);
//   * nothing here can change a submission: a failure of any step leaves the finalized entry exactly as it was.

export type Claimed = { to: string; reference: string; eventId: number; attempt: number };
export type OutboxDb = {
  enqueue(submissionId: string): Promise<string>;
  claim(id: string): Promise<Claimed | null>;
  finish(id: string, outcome: "sent" | "transient" | "permanent"): Promise<void>;
  due(limit: number): Promise<string[]>;
};
export type EmailDeps = { db: OutboxDb; provider: EmailProvider | null };
export type SendOutcome = "sent" | "retry" | "abandoned" | "skipped";

export async function sendOutboxEmail(deps: { db: OutboxDb; provider: EmailProvider }, id: string): Promise<SendOutcome> {
  let claimed: Claimed | null;
  try {
    claimed = await deps.db.claim(id);
  } catch {
    return "skipped"; // the database could not be reached: nothing was claimed, nothing was sent
  }
  if (!claimed) return "skipped"; // not due, already being sent by someone else, already sent, or no longer a finalized entry

  const finish = async (outcome: "sent" | "transient" | "permanent") => {
    try {
      await deps.db.finish(id, outcome);
    } catch {
      // left as "sending": its lock runs out and it is tried again; the provider's idempotency key stops a second copy
    }
  };

  let message;
  try {
    message = renderParticipationEmail({ eventId: claimed.eventId, reference: claimed.reference });
  } catch {
    await finish("permanent"); // a row that can never be rendered is not retried
    return "abandoned";
  }
  let result;
  try {
    result = await deps.provider.send({ to: claimed.to, ...message, idempotencyKey: `rio-participation-${id}` });
  } catch {
    result = { ok: false as const, retryable: true };
  }
  if (result.ok) {
    await finish("sent");
    return "sent";
  }
  if (result.retryable) {
    await finish("transient");
    return claimed.attempt >= 8 ? "abandoned" : "retry";
  }
  await finish("permanent");
  return "abandoned";
}

/** After a successful final submission. Never throws, never blocks the caller's result. */
export async function queueParticipationEmail(deps: EmailDeps, submissionId: string): Promise<"queued" | "sent" | "failed"> {
  let id: string;
  try {
    id = await deps.db.enqueue(submissionId);
  } catch {
    return "failed"; // for example the outbox migration is not applied yet: the submission is unaffected
  }
  if (!deps.provider) return "queued"; // sending is switched off or not configured: the row waits
  try {
    return (await sendOutboxEmail({ db: deps.db, provider: deps.provider }, id)) === "sent" ? "sent" : "queued";
  } catch {
    return "queued";
  }
}

/** Sends what is due (oldest first, at most `limit`). Used by the retry script. */
export async function sweepOutbox(deps: { db: OutboxDb; provider: EmailProvider }, limit = 20): Promise<Record<SendOutcome, number>> {
  const tally: Record<SendOutcome, number> = { sent: 0, retry: 0, abandoned: 0, skipped: 0 };
  let ids: string[] = [];
  try {
    ids = await deps.db.due(limit);
  } catch {
    return tally;
  }
  for (const id of ids) tally[await sendOutboxEmail(deps, id)] += 1;
  return tally;
}
