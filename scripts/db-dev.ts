// Guarded entry point for anything that talks to a hosted Supabase database.
//
//   node scripts/db-dev.ts check      offline: validates the target, prints the plan, runs nothing
//   node scripts/db-dev.ts dry-run    supabase db push --dry-run against the DEV project (reads migration history only)
//   node scripts/db-dev.ts push       supabase db push --yes against the DEV project         (WRITES to the dev database)
//   node scripts/db-dev.ts check-live validates the live-test target (used by `npm run test:live`)
//
// Two ways to reach the dev database:
//   * IPv4 Session Pooler (preferred on networks without IPv6): SUPABASE_DEV_POOLER_URL, read from .env.live.
//     Must be postgresql://postgres.<dev ref>:<password>@aws-N-<region>.pooler.supabase.com:5432/postgres
//     Port 5432 only. The Transaction Pooler (6543), direct hosts and any other host are refused.
//   * Direct connection by ref (needs IPv6): --remote=<dev ref>, password from SUPABASE_DB_PASSWORD.
//
// Rules enforced here, in code, before any CLI call:
//   * RIO_DEV_PROJECT_REF must be set and must NOT be the project in .env (treated as production).
//   * A bare `--remote` (the "linked project") is never used; the target is always explicit.
//   * The pooler URL's username must be exactly postgres.<RIO_DEV_PROJECT_REF>.
//   * If the CLI is linked (supabase/.temp/project-ref), it must be linked to the dev ref.
//   * `push` needs RIO_CONFIRM_PUSH to equal the dev ref, typed by a human.
// Credentials: nothing here prints a password or connection URL. Errors are fixed strings that never
// echo input, and everything the CLI prints is passed through redact() first. The CLI is started
// without a shell, so the URL is never parsed by cmd.exe or sh.
// Limit: while the CLI runs, the URL is in its argument list, visible to other processes of the same user.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertSafeLiveTarget, GuardError, readProductionPublishableKey, readProductionRef, REF, type Env } from "./live-target.ts";

// The live-target guard lives in live-target.ts so Playwright (which cannot load this file) can use it too.
export { assertSafeLiveTarget, GuardError, keyKind, projectRefFromUrl, readProductionPublishableKey, readProductionRef, type Env, type LiveTarget } from "./live-target.ts";

const POOLER_HOST = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/;
const SECRET_ENV_NAMES = ["SUPABASE_DB_PASSWORD", "SUPABASE_DEV_POOLER_URL", "RIO_LIVE_SECRET_KEY", "SUPABASE_ACCESS_TOKEN"];

export function readLinkedRef(file = "supabase/.temp/project-ref"): string | null {
  return existsSync(file) ? readFileSync(file, "utf8").trim() || null : null;
}

export type PoolerTarget = { host: string; password: string };

/**
 * Validates a Session Pooler URL for the DEV project. Error messages are fixed strings: they never
 * include any part of the input, so a rejected URL cannot leak a password through an error.
 */
export function parseSessionPoolerUrl(raw: string, devRef: string, prodRef: string | null): PoolerTarget {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new GuardError("SUPABASE_DEV_POOLER_URL is not a valid URL (if the password has special characters, percent-encode them).");
  }
  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") throw new GuardError("SUPABASE_DEV_POOLER_URL must use the postgresql:// scheme.");
  if (!POOLER_HOST.test(u.hostname)) throw new GuardError("SUPABASE_DEV_POOLER_URL host must be a Supabase Session Pooler host (aws-N-<region>.pooler.supabase.com).");
  if (u.port !== "5432") throw new GuardError("SUPABASE_DEV_POOLER_URL port must be 5432 (Session Pooler). The Transaction Pooler (6543) and other ports are refused.");
  let user: string;
  let password: string;
  try {
    user = decodeURIComponent(u.username);
    password = decodeURIComponent(u.password);
  } catch {
    throw new GuardError("SUPABASE_DEV_POOLER_URL has an invalid percent-encoded username or password.");
  }
  if (prodRef && user.endsWith(`.${prodRef}`)) throw new GuardError("SUPABASE_DEV_POOLER_URL username belongs to the production project. Refusing.");
  if (user !== `postgres.${devRef}`) throw new GuardError("SUPABASE_DEV_POOLER_URL username must be exactly postgres.<RIO_DEV_PROJECT_REF>; the project references do not match.");
  if (!password) throw new GuardError("SUPABASE_DEV_POOLER_URL has no password.");
  if (u.pathname !== "/postgres") throw new GuardError("SUPABASE_DEV_POOLER_URL database must be /postgres.");
  if (u.search || u.hash) throw new GuardError("SUPABASE_DEV_POOLER_URL must not contain query parameters or a fragment.");
  return { host: u.hostname, password };
}

/** Remove credentials from any text before it is shown: known secrets, their encoded forms, and any postgres URL. */
export function redact(text: string, secrets: Iterable<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    for (const form of new Set([s, encodeURIComponent(s)])) out = out.split(form).join("[redacted]");
  }
  return out.replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, "[redacted-url]");
}

export type Plan = {
  devRef: string;
  method: "session-pooler" | "direct";
  args: string[];
  writes: boolean;
  poolerHost?: string;
  secrets: string[];
};

export function planDevCommand(
  command: "check" | "dry-run" | "push",
  env: Env,
  prodRef: string | null,
  linkedRef: string | null,
): Plan {
  const devRef = env.RIO_DEV_PROJECT_REF ?? "";
  if (!REF.test(devRef)) throw new GuardError("RIO_DEV_PROJECT_REF is missing or not a 20-character project ref.");
  if (prodRef && devRef === prodRef) throw new GuardError("RIO_DEV_PROJECT_REF is the production project from .env. Refusing.");
  if (linkedRef && linkedRef !== devRef) throw new GuardError("The Supabase CLI is linked to a different project than RIO_DEV_PROJECT_REF. Refusing.");

  const rawUrl = env.SUPABASE_DEV_POOLER_URL;
  let remote = devRef;
  let method: Plan["method"] = "direct";
  let poolerHost: string | undefined;
  const secrets = [env.SUPABASE_DB_PASSWORD ?? ""];
  if (rawUrl) {
    const target = parseSessionPoolerUrl(rawUrl, devRef, prodRef);
    remote = rawUrl;
    method = "session-pooler";
    poolerHost = target.host;
    secrets.push(rawUrl, target.password);
  }

  const base = ["supabase", "db", "push", `--remote=${remote}`];
  if (command === "push") {
    if (env.RIO_CONFIRM_PUSH !== devRef) throw new GuardError("Set RIO_CONFIRM_PUSH to the dev project ref to confirm a real push.");
    return { devRef, method, args: [...base, "--yes"], writes: true, poolerHost, secrets };
  }
  return { devRef, method, args: [...base, "--dry-run"], writes: false, poolerHost, secrets };
}

// ---------------------------------------------------------------------------------------------
// Read-only inspection of the DEV database. Only the fixed queries below can run (no arbitrary
// SQL), each is re-checked by assertReadOnlySql, and the CLI runs it with --read-only so Postgres
// itself rejects any write. Results contain schema facts and the six seeded events, not personal data.
// ---------------------------------------------------------------------------------------------
const PRIV_ROLES = `(values ('anon'), ('authenticated'))`;
export const INSPECTIONS: Record<string, string> = {
  version: `select current_setting('server_version') as server_version, current_setting('server_encoding') as encoding, current_database() as database`,
  history: `select version, name from supabase_migrations.schema_migrations order by version`,
  history_statements: `select version, name, statements from supabase_migrations.schema_migrations order by version`,
  relations: `select c.relname as name, c.relkind::text as kind, c.relrowsecurity as rls, c.relforcerowsecurity as forced, (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'p') order by c.relkind, c.relname`,
  row_counts: `select (select count(*) from public.events) as events, (select count(*) from public.event_settings) as event_settings, (select count(*) from public.submissions) as submissions, (select count(*) from public.scores) as scores, (select count(*) from public.judge_assignments) as judge_assignments, (select count(*) from public.judge_profiles) as judge_profiles, (select count(*) from public.user_roles) as user_roles, (select count(*) from public.winners) as winners, (select count(*) from public.audit_log) as audit_log`,
  events: `select id, slug, name_ta, name_en, min_age, max_age from public.events order by id`,
  settings: `select submissions_open_at, submissions_close_at, current_consent_version, results_publish_at from public.event_settings`,
  functions: `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig, p.prosecdef as security_definer, coalesce(p.proconfig::text, '') as config, pg_get_userbyid(p.proowner) as owner, (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')) as public_exec, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed_exec from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') order by 1`,
  triggers: `select c.relname as tbl, t.tgname as name, t.tgenabled::text as enabled from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and c.relnamespace = 'public'::regnamespace order by 1, 2`,
  policies: `select tablename, policyname, cmd, roles::text as roles, permissive, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2`,
  grants: `with roles(r) as ${PRIV_ROLES}, rels as (select c.oid, c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'p')) select r as role, relname as rel, (select coalesce(string_agg(p, ',' order by p), '') from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where has_table_privilege(r, rels.oid, p)) as tbl, (select coalesce(string_agg(a.attname, ',' order by a.attname), '') from pg_attribute a where a.attrelid = rels.oid and a.attnum > 0 and not a.attisdropped and has_column_privilege(r, rels.oid, a.attnum, 'SELECT') and not has_table_privilege(r, rels.oid, 'SELECT')) as sel, (select coalesce(string_agg(a.attname, ',' order by a.attname), '') from pg_attribute a where a.attrelid = rels.oid and a.attnum > 0 and not a.attisdropped and has_column_privilege(r, rels.oid, a.attnum, 'INSERT') and not has_table_privilege(r, rels.oid, 'INSERT')) as ins, (select coalesce(string_agg(a.attname, ',' order by a.attname), '') from pg_attribute a where a.attrelid = rels.oid and a.attnum > 0 and not a.attisdropped and has_column_privilege(r, rels.oid, a.attnum, 'UPDATE') and not has_table_privilege(r, rels.oid, 'UPDATE')) as upd from roles cross join rels order by 1, 2`,
  schema_access: `select has_schema_privilege('anon', 'private', 'USAGE') as anon_private, has_schema_privilege('authenticated', 'private', 'USAGE') as authed_private, has_schema_privilege('anon', 'public', 'USAGE') as anon_public, has_schema_privilege('authenticated', 'public', 'USAGE') as authed_public`,
  default_privileges: `select pg_get_userbyid(defaclrole) as owner, defaclnamespace::regnamespace::text as schema, defaclobjtype::text as kind, defaclacl::text as acl from pg_default_acl order by 1, 2, 3`,
  view_options: `select relname, coalesce(reloptions::text, '') as options, pg_get_userbyid(relowner) as owner from pg_class where relnamespace = 'public'::regnamespace and relkind = 'v' order by 1`,
  judge_entries_definition: `select pg_get_viewdef('public.judge_entries'::regclass, true) as definition`,
  auth_foreign_keys: `select conrelid::regclass::text as tbl, conname as name from pg_constraint where confrelid = 'auth.users'::regclass order by 1, 2`,
  unindexed_foreign_keys: `select c.conrelid::regclass::text || '.' || a.attname as col from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1] where c.contype = 'f' and c.connamespace = 'public'::regnamespace and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1]) order by 1`,
  realtime_publication: `select pubname, schemaname, tablename from pg_publication_tables where schemaname in ('public', 'private') order by 1, 2, 3`,
  view_definitions: `select c.relname as name, pg_get_viewdef(c.oid, true) as definition from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'v' order by 1`,
  view_acls: `select c.relname as name, coalesce((select string_agg(coalesce(nullif(a.grantee, 0)::regrole::text, 'PUBLIC') || ':' || a.privilege_type || case when a.is_grantable then '*' else '' end, ',' order by a.privilege_type, a.grantee) from aclexplode(c.relacl) a), 'owner only') as acl from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'v' order by 1`,
  owner_roles: `select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname in ('postgres', 'authenticated', 'anon', 'service_role') order by 1`,
  helper_function_definitions: `select p.proname as name, pg_get_functiondef(p.oid) as definition from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname in ('is_admin', 'is_judge', 'is_staff', 'judge_can_score', 'results_published') order by 1`,
  submissions_columns: `select column_name as name, data_type as type, is_nullable as nullable, coalesce(column_default, '') as column_default, is_generated as generated from information_schema.columns where table_schema = 'public' and table_name = 'submissions' order by ordinal_position`,
  extensions: `select e.extname as name, e.extnamespace::regnamespace::text as schema, e.extversion as version from pg_extension e order by 1`,
  video_function_acls: `select p.proname as name, p.provolatile::text as volatility, coalesce(p.proacl::text, 'default') as acl from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%video_upload%' order by 1`,
  video_uploads_table: `select c.relname as name, coalesce(c.relacl::text, 'default') as acl, c.relrowsecurity as rls, pg_get_userbyid(c.relowner) as owner, (select count(*) from public.video_uploads) as rows, (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = 'video_uploads') as policies from pg_class c where c.oid = 'public.video_uploads'::regclass`,
  // M4B/M5: who may run the final-submission and judging functions, and a fingerprint of each body (md5 of the stored source text).
  judging_function_acls: `select p.proname as name, pg_get_userbyid(p.proowner) as owner, p.prosecdef as security_definer, coalesce(p.proconfig::text, '') as config, coalesce(p.proacl::text, 'default') as acl, has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed_exec, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec, md5(p.prosrc) as body_md5 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('check_finalize', 'finalize_verified_submission', 'authorize_playback', 'assign_judge_to_event', 'finalize_submission', 'issue_video_upload', 'attach_video_upload', 'withdraw_submission', 'unlock_score') order by 1`,
  other_objects:`select (select count(*) from pg_class where relnamespace = 'public'::regnamespace) as public_relations, (select count(*) from pg_namespace where nspname = 'private') as private_schema, (select count(*) from pg_extension where extname in ('pgcrypto', 'pg_cron', 'pg_net')) as extensions_checked`,
};

const FORBIDDEN_SQL =
  /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|call|execute|do|set|reset|vacuum|analyze|lock|notify|listen|comment|refresh|reindex|cluster|discard|set_config|nextval|setval|pg_terminate_backend|pg_cancel_backend|lo_import|lo_export|dblink|pg_read_file|pg_sleep)\b/i;

/** A query may run only if it is a single SELECT/WITH statement with no write or side-effect keyword outside string literals. */
export function assertReadOnlySql(sql: string): void {
  const bare = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/;\s*$/, "");
  if (!/^\s*(select|with)\b/i.test(bare)) throw new GuardError("Only SELECT queries may be inspected.");
  if (bare.includes(";")) throw new GuardError("Only a single statement may be inspected.");
  if (FORBIDDEN_SQL.test(bare)) throw new GuardError("A write or side-effect keyword was found in an inspection query.");
}

/** A read-only query against the verified DEV target (same checks as every other command). */
export function planInspection(env: Env, prodRef: string | null, linkedRef: string | null, name: string): Plan {
  const sql = INSPECTIONS[name];
  if (!sql) throw new GuardError("Unknown inspection name.");
  assertReadOnlySql(sql);
  const base = planDevCommand("check", env, prodRef, linkedRef);
  return { ...base, args: ["supabase", "db", "query", base.args[3]!, "--read-only", "--output-format", "json", sql], writes: false };
}

/** The Supabase security and performance advisors for the verified DEV target. */
export function planAdvisors(env: Env, prodRef: string | null, linkedRef: string | null): Plan {
  const base = planDevCommand("check", env, prodRef, linkedRef);
  return { ...base, args: ["supabase", "db", "advisors", base.args[3]!, "--type", "all", "--level", "info", "--output-format", "json"], writes: false };
}

const mask = (ref: string) => `${ref.slice(0, 4)}…${ref.slice(-2)}`;

function runCli(plan: Plan): number {
  // The CLI is a Node script; run it directly (no shell, no .cmd shim) so the URL is never re-parsed.
  const cli = join(process.cwd(), "node_modules", "supabase", "dist", "supabase.js");
  if (!existsSync(cli)) throw new GuardError("The Supabase CLI is not installed. Run npm install.");
  const secrets = [...plan.secrets, ...SECRET_ENV_NAMES.map((n) => process.env[n])];
  const res = spawnSync(process.execPath, [cli, ...plan.args.slice(1)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (res.stdout) process.stdout.write(redact(res.stdout, secrets));
  if (res.stderr) process.stderr.write(redact(res.stderr, secrets));
  if (res.error) console.error("The Supabase CLI could not be started.");
  return res.status ?? 1;
}

function main(argv: string[]): number {
  const command = argv[0];
  try {
    if (command === "check-live") {
      const t = assertSafeLiveTarget(process.env, readProductionRef(), readProductionPublishableKey());
      console.log(`live tests target: ${t.ref === "local" ? "local stack" : `dev project ${mask(t.ref)}`}`);
      return 0;
    }
    if (command === "inspect" || command === "advisors") {
      const prod = readProductionRef();
      const linked = readLinkedRef();
      const names = command === "advisors" ? [""] : argv.length > 1 ? argv.slice(1) : Object.keys(INSPECTIONS);
      let worst = 0;
      for (const name of names) {
        const plan = command === "advisors" ? planAdvisors(process.env, prod, linked) : planInspection(process.env, prod, linked, name);
        console.log(`=== ${command === "advisors" ? "advisors" : name} (dev ${mask(plan.devRef)}, read-only) ===`);
        worst = Math.max(worst, runCli(plan));
      }
      return worst;
    }
    if (command !== "check" && command !== "dry-run" && command !== "push") {
      console.error("usage: node scripts/db-dev.ts <check|dry-run|push|inspect|advisors|check-live>");
      return 2;
    }
    const plan = planDevCommand(command, process.env, readProductionRef(), readLinkedRef());
    console.log(`target: dev project ${mask(plan.devRef)} | mode: ${command} | writes: ${plan.writes}`);
    if (plan.method === "session-pooler") {
      console.log(`connection: Session Pooler (IPv4) | host: ${plan.poolerHost} | port: 5432 | user: postgres.${mask(plan.devRef)} | database: postgres`);
      console.log(`command: supabase db push --remote=<session pooler URL, hidden> ${plan.args.slice(4).join(" ")}`);
    } else {
      console.log("connection: direct by project ref (needs IPv6); set SUPABASE_DEV_POOLER_URL to use the IPv4 Session Pooler");
      console.log(`command: supabase db push --remote=${mask(plan.devRef)} ${plan.args.slice(4).join(" ")}`);
    }
    return command === "check" ? 0 : runCli(plan);
  } catch (e) {
    if (e instanceof GuardError) {
      console.error(`REFUSED: ${e.message}`);
      return 3;
    }
    // Never let an unexpected error print raw: scrub any credential-looking text first.
    const secrets = SECRET_ENV_NAMES.map((n) => process.env[n]);
    console.error(redact(e instanceof Error ? e.message : "Unexpected error.", secrets));
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
