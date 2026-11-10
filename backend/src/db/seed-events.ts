import { writeAudit } from "../auth/audit.ts";
import type { DatabaseAdapter, Queryable } from "./adapter.ts";
import { COMPETITIONS, type Competition } from "./seed/competitions.ts";

// Puts the six competitions into the `events` table of a LOCAL development database. Rules:
//   * idempotent: a competition that is already there with the same slug, names and ages is left alone;
//   * never overwrites: if a slug exists with different names or ages, NOTHING is written and the differences are reported (an organizer may have
//     changed it on purpose, or the data may be wrong; a person decides, not this script);
//   * never touches anything else: organizer-added competitions, display order, the active flag, question sets, entries and settings are untouched;
//   * everything in one transaction, with one audit row when something was created.

export type SeedPlan = {
  toCreate: Competition[];
  unchanged: string[];
  conflicts: { slug: string; fields: string[] }[];
  /** Competitions in the table that are not among the six (added by an organizer): reported, never touched. */
  others: string[];
};

export class SeedConflict extends Error {
  override name = "SeedConflict";
  readonly conflicts: { slug: string; fields: string[] }[];
  constructor(conflicts: { slug: string; fields: string[] }[]) {
    super(`Existing competitions differ from the approved list (${conflicts.map((c) => `${c.slug}: ${c.fields.join(", ")}`).join("; ")}). Nothing was written.`);
    this.conflicts = conflicts;
  }
}

type Row = { slug: string; name_ta: string; name_en: string; min_age: number | string; max_age: number | string };

/** Reads only. */
export async function planSeed(db: Queryable): Promise<SeedPlan> {
  const rows = (await db.query<Row>("SELECT slug, name_ta, name_en, min_age, max_age FROM events")).rows;
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const plan: SeedPlan = { toCreate: [], unchanged: [], conflicts: [], others: rows.map((r) => r.slug).filter((s) => !COMPETITIONS.some((c) => c.slug === s)).sort() };
  for (const c of COMPETITIONS) {
    const row = bySlug.get(c.slug);
    if (!row) {
      plan.toCreate.push(c);
      continue;
    }
    const fields = [
      ...(row.name_ta !== c.nameTa ? ["name_ta"] : []),
      ...(row.name_en !== c.nameEn ? ["name_en"] : []),
      ...(Number(row.min_age) !== c.minAge ? ["min_age"] : []),
      ...(Number(row.max_age) !== c.maxAge ? ["max_age"] : []),
    ];
    if (fields.length > 0) plan.conflicts.push({ slug: c.slug, fields });
    else plan.unchanged.push(c.slug);
  }
  return plan;
}

export type SeedResult = { created: string[]; unchanged: string[]; others: string[] };

export async function applySeed(db: DatabaseAdapter, now: Date): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    const plan = await planSeed(tx); // read again inside the transaction: the decision and the writes see the same data
    if (plan.conflicts.length > 0) throw new SeedConflict(plan.conflicts);
    for (const c of plan.toCreate) {
      await tx.query("INSERT INTO events (slug, name_ta, name_en, min_age, max_age, display_order, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)", [
        c.slug, c.nameTa, c.nameEn, c.minAge, c.maxAge, c.number, now,
      ]);
    }
    if (plan.toCreate.length > 0) {
      await writeAudit(tx, now, { actorType: "system", action: "events.seeded", entityType: "event", details: { created: plan.toCreate.length, already_present: plan.unchanged.length } });
    }
    return { created: plan.toCreate.map((c) => c.slug), unchanged: plan.unchanged, others: plan.others };
  });
}
