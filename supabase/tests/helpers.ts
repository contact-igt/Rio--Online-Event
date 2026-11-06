import type { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

const HERE = import.meta.dirname;
const ROOT = join(HERE, "..");
export const MIGRATIONS_DIR = join(ROOT, "migrations");

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * Engine under test. Default is the current PGlite (Postgres 18). `RIO_PG_ENGINE=17` runs the same
 * suite on Postgres 17, the major version pinned in supabase/config.toml (npm run test:pg17).
 */
const engineModule =
  process.env.RIO_PG_ENGINE === "17" ? await import("pglite-pg17") : await import("@electric-sql/pglite");
const Engine = engineModule.PGlite as unknown as new () => PGlite;

/** A fresh in-memory Postgres with only the Supabase stand-ins applied (no migrations). */
export async function createBareDb(): Promise<PGlite> {
  const db = new Engine();
  await db.waitReady;
  await db.exec(readFileSync(join(HERE, "supabase-shim.sql"), "utf8"));
  return db;
}

export async function applyMigrations(db: PGlite): Promise<void> {
  for (const file of migrationFiles()) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
}

/** A fresh in-memory Postgres with the Supabase stand-ins and every migration applied in order. */
export async function createDb(): Promise<PGlite> {
  const db = await createBareDb();
  await applyMigrations(db);
  return db;
}

/** One database per test file; every test runs in a transaction that is rolled back, with basics seeded. */
export function setupDb(): () => PGlite {
  let db: PGlite;
  beforeAll(async () => {
    db = await createDb();
  });
  beforeEach(async () => {
    await db.exec("begin");
    await seedBasics(db);
  });
  afterEach(async () => {
    await db.exec("rollback");
  });
  afterAll(async () => {
    await db.close();
  });
  return () => db;
}

export const ids = {
  parentA: "aaaaaaaa-0000-4000-8000-00000000000a",
  parentB: "bbbbbbbb-0000-4000-8000-00000000000b",
  judge1: "11111111-0000-4000-8000-000000000001",
  judge2: "22222222-0000-4000-8000-000000000002",
  admin: "ad000000-0000-4000-8000-0000000000ad",
  admin2: "ad000000-0000-4000-8000-0000000000a2",
  stranger: "99999999-0000-4000-8000-000000000009",
} as const;

export type Who = keyof typeof ids | "anon" | "superuser" | "service";

/** Run inside a transaction: act as a Supabase caller (the way PostgREST does) for following statements. */
export async function actAs(db: PGlite, who: Who): Promise<void> {
  await db.exec("reset role");
  if (who === "superuser") return;
  if (who === "service") {
    await db.exec("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true); set local role service_role");
    return;
  }
  if (who === "anon") {
    await db.exec("select set_config('request.jwt.claims', '{\"role\":\"anon\"}', true); set local role anon");
    return;
  }
  const claims = JSON.stringify({ sub: ids[who], role: "authenticated" });
  await db.query("select set_config('request.jwt.claims', $1, true)", [claims]);
  await db.exec("set local role authenticated");
}

/** Statements run as `who`; returns rows. */
export async function q<T = Record<string, unknown>>(db: PGlite, who: Who, sql: string, params: unknown[] = []): Promise<T[]> {
  await actAs(db, who);
  const res = await db.query<T>(sql, params);
  return res.rows;
}

export type DbError = { code?: string; message: string };

/**
 * Run a statement that must fail and return the error. Uses a savepoint so the surrounding
 * transaction stays usable. Fails the test if the statement succeeds.
 */
export async function fails(db: PGlite, who: Who, sql: string, params: unknown[] = []): Promise<DbError> {
  await actAs(db, who);
  await db.exec("savepoint expect_fail");
  try {
    await db.query(sql, params);
  } catch (e) {
    await db.exec("rollback to savepoint expect_fail");
    return e as DbError;
  }
  await db.exec("release savepoint expect_fail");
  throw new Error(`Expected statement to fail as ${who}, but it succeeded: ${sql}`);
}

export const PG = {
  insufficientPrivilege: "42501",
  checkViolation: "23514",
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  raiseException: "P0001",
} as const;

/** Create auth users, roles and settings used by most tests (as superuser). */
export async function seedBasics(db: PGlite): Promise<void> {
  await actAs(db, "superuser");
  for (const [name, id] of Object.entries(ids)) {
    await db.query("insert into auth.users (id, email) values ($1, $2)", [id, `${name}@example.test`]);
  }
  await db.query("insert into public.user_roles (user_id, role) values ($1,'admin'),($2,'admin'),($3,'judge'),($4,'judge')", [
    ids.admin,
    ids.admin2,
    ids.judge1,
    ids.judge2,
  ]);
  await db.query("insert into public.judge_profiles (user_id, display_name) values ($1,'Judge One'),($2,'Judge Two')", [
    ids.judge1,
    ids.judge2,
  ]);
  await db.exec(`
    update public.event_settings set
      submissions_open_at = now() - interval '1 day',
      submissions_close_at = now() + interval '30 days',
      current_consent_version = 'v1';
  `);
}

export type NewSubmission = {
  owner: string;
  event?: number;
  childName?: string;
  age?: number;
  parentName?: string;
  email?: string;
  mobile?: string;
};

/** Insert a draft as superuser (owner given explicitly). Returns the submission id. */
export async function insertDraft(db: PGlite, s: NewSubmission): Promise<string> {
  await actAs(db, "superuser");
  const res = await db.query<{ id: string }>(
    `insert into public.submissions (owner_id, event_id, child_name, child_age, parent_name, parent_email, parent_mobile, consent_version)
     values ($1,$2,$3,$4,$5,$6,$7,'v1') returning id`,
    [s.owner, s.event ?? 2, s.childName ?? "Asha Test", s.age ?? 6, s.parentName ?? "Parent Test", s.email ?? "parent@example.test", s.mobile ?? "+91 98765 43210"],
  );
  return res.rows[0]!.id;
}

/**
 * Takes a draft through the real upload functions (as the service role does): issue an authorization, then attach it as verified.
 * Returns what a verified record holds, i.e. what the server would later compare the bucket's current object with.
 */
export async function uploadVerified(db: PGlite, owner: string, submission: string, over: { bytes?: number; type?: string; etag?: string } = {}) {
  const bytes = over.bytes ?? 20 * 1024 * 1024;
  const type = over.type ?? "video/mp4";
  const etag = over.etag ?? '"etag-verified"';
  await actAs(db, "service");
  const issued = await db.query<{ upload_id: string }>("select * from public.issue_video_upload($1,$2,$3,$4)", [owner, submission, type, bytes]);
  const upload = issued.rows[0]!.upload_id;
  await db.query("select public.attach_video_upload($1,$2,$3,$4,$5)", [owner, upload, bytes, type, etag]);
  return { upload, bytes, type, etag };
}

/** Move a draft to finalized as superuser (the unit tests for transitions use other paths). */
export async function finalize(db: PGlite, id: string): Promise<void> {
  await actAs(db, "superuser");
  await db.query("update public.submissions set status='uploaded', video_key=gen_random_uuid() where id=$1", [id]);
  await db.query("update public.submissions set status='finalized' where id=$1", [id]);
}
