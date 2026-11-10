import type { Queryable } from "../db/adapter.ts";

// One row in audit_log (append-only, see migration 0002). `details` holds fixed labels and ids only: never a password, a token, an e-mail
// address, an IP address or any text the user typed. Pass the transaction's Queryable to make the row part of the change it describes.

export type AuditEntry = {
  actorType: "staff" | "system" | "public";
  actorStaffId?: number | null;
  action: string;
  entityType: string;
  entityId?: number | string | null;
  requestId?: string | null;
  details?: Record<string, string | number | boolean | null>;
};

export async function writeAudit(q: Queryable, now: Date, entry: AuditEntry): Promise<void> {
  await q.query(
    "INSERT INTO audit_log (occurred_at, actor_type, actor_staff_id, action, entity_type, entity_id, request_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      now,
      entry.actorType,
      entry.actorStaffId ?? null,
      entry.action,
      entry.entityType,
      entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId),
      entry.requestId ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
    ],
  );
}
