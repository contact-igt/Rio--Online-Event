import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events } from "../../../website/lib/events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { actAs, applyMigrations, createBareDb, createDb, migrationFiles } from "./helpers";

let db: PGlite;
beforeAll(async () => {
  db = await createDb(); // applies every migration, in order, to an empty database
});
afterAll(async () => {
  await db.close();
});

async function fingerprint(d: PGlite): Promise<string> {
  const res = await d.query<{ f: string }>(`
    select jsonb_build_object(
      'columns', (select jsonb_agg(jsonb_build_array(table_name, column_name, data_type, is_nullable, column_default, is_generated) order by table_name, ordinal_position)
                  from information_schema.columns where table_schema = 'public'),
      'policies', (select jsonb_agg(jsonb_build_array(tablename, policyname, cmd, roles, qual, with_check) order by tablename, policyname) from pg_policies where schemaname = 'public'),
      'triggers', (select jsonb_agg(tgname order by tgname) from pg_trigger where not tgisinternal),
      'constraints', (select jsonb_agg(conname || ':' || pg_get_constraintdef(oid) order by conname) from pg_constraint where connamespace = 'public'::regnamespace),
      'functions', (select jsonb_agg(pg_get_functiondef(p.oid) order by p.proname) from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)),
      'events', (select jsonb_agg(to_jsonb(e) order by id) from public.events e)
    )::text as f`);
  return res.rows[0]!.f;
}

describe("migrations", () => {
  it("are named with strictly increasing timestamps", () => {
    const files = migrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) expect(f).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
    const stamps = files.map((f) => f.slice(0, 14));
    expect(new Set(stamps).size).toBe(stamps.length);
    expect([...stamps].sort()).toEqual(stamps);
  });

  it("replay from empty to an identical schema", async () => {
    const second = await createDb();
    try {
      expect(await fingerprint(second)).toBe(await fingerprint(db));
    } finally {
      await second.close();
    }
  });

  it("enable row level security on every public table", async () => {
    await actAs(db, "superuser");
    const res = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "select c.relname, c.relrowsecurity from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1",
    );
    expect(res.rows.length).toBeGreaterThanOrEqual(9);
    expect(res.rows.filter((r) => !r.relrowsecurity)).toEqual([]);
  });

  it("seed the six events exactly as lib/events.ts defines them", async () => {
    await actAs(db, "superuser");
    const res = await db.query<{ id: number; slug: string; name_ta: string; name_en: string; min_age: number; max_age: number }>(
      "select id, slug, name_ta, name_en, min_age, max_age from public.events order by id",
    );
    expect(res.rows).toEqual(
      events.map((e) => ({ id: e.number, slug: e.slug, name_ta: e.nameTa, name_en: e.nameEn, min_age: e.minAge, max_age: e.maxAge })),
    );
  });

  it("store no date of birth and no video URL", async () => {
    await actAs(db, "superuser");
    const cols = await db.query<{ table_name: string; column_name: string; data_type: string }>(
      "select table_name, column_name, data_type from information_schema.columns where table_schema = 'public'",
    );
    expect(cols.rows.filter((c) => /birth|dob/i.test(c.column_name))).toEqual([]);
    expect(cols.rows.filter((c) => /url|link|path/i.test(c.column_name))).toEqual([]);
    const key = cols.rows.find((c) => c.table_name === "submissions" && c.column_name === "video_key");
    expect(key?.data_type).toBe("uuid");
  });

  it("start closed: no submission window, no consent version, no results time", async () => {
    await actAs(db, "superuser");
    const res = await db.query("select submissions_open_at, submissions_close_at, current_consent_version, results_publish_at from public.event_settings");
    expect(res.rows).toEqual([
      { submissions_open_at: null, submissions_close_at: null, current_consent_version: null, results_publish_at: null },
    ]);
  });
});

describe("grant surface (any change here needs a security review)", () => {
  type Row = { role: string; rel: string; sel: string; tbl: string; ins: string; upd: string };

  async function snapshot(): Promise<string[]> {
    await actAs(db, "superuser");
    const res = await db.query<Row>(`
      with roles(r) as (values ('anon'), ('authenticated')),
      rels as (
        select c.oid, c.relname from pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'p')
      )
      select r as role, relname as rel,
        (select coalesce(string_agg(p, ',' order by p), '') from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
          where has_table_privilege(r, rels.oid, p)) as tbl,
        (select coalesce(string_agg(a.attname, ',' order by a.attname), '') from pg_attribute a
          where a.attrelid = rels.oid and a.attnum > 0 and not a.attisdropped
            and has_column_privilege(r, rels.oid, a.attnum, 'SELECT') and not has_table_privilege(r, rels.oid, 'SELECT')) as sel,
        (select coalesce(string_agg(a.attname, ',' order by a.attname), '') from pg_attribute a
          where a.attrelid = rels.oid and a.attnum > 0 and not a.attisdropped
            and has_column_privilege(r, rels.oid, a.attnum, 'INSERT') and not has_table_privilege(r, rels.oid, 'INSERT')) as ins,
        (select coalesce(string_agg(a.attname, ',' order by a.attname), '') from pg_attribute a
          where a.attrelid = rels.oid and a.attnum > 0 and not a.attisdropped
            and has_column_privilege(r, rels.oid, a.attnum, 'UPDATE') and not has_table_privilege(r, rels.oid, 'UPDATE')) as upd
      from roles cross join rels
      order by 1, 2`);
    return res.rows
      .filter((x) => x.tbl || x.sel || x.ins || x.upd)
      .map((x) => `${x.role} ${x.rel} table[${x.tbl}] select-cols[${x.sel}] insert-cols[${x.ins}] update-cols[${x.upd}]`)
      .sort();
  }

  it("tables and views: exactly these privileges, nothing more", async () => {
    expect(await snapshot()).toEqual(
      [
      "anon event_settings table[SELECT] select-cols[] insert-cols[] update-cols[]",
      "anon events table[SELECT] select-cols[] insert-cols[] update-cols[]",
      "anon published_winners table[SELECT] select-cols[] insert-cols[] update-cols[]",
      "authenticated audit_log table[SELECT] select-cols[] insert-cols[] update-cols[]",
      "authenticated event_settings table[SELECT] select-cols[] insert-cols[] update-cols[current_consent_version,results_publish_at,submissions_close_at,submissions_open_at]",
      "authenticated events table[SELECT] select-cols[] insert-cols[] update-cols[]",
      "authenticated judge_assignments table[DELETE,SELECT] select-cols[] insert-cols[judge_id,submission_id] update-cols[]",
      "authenticated judge_entries table[SELECT] select-cols[] insert-cols[] update-cols[]",
      "authenticated judge_profiles table[DELETE,SELECT] select-cols[] insert-cols[active,display_name,user_id] update-cols[active,display_name]",
      "authenticated published_winners table[SELECT] select-cols[] insert-cols[] update-cols[]",
      "authenticated scores table[SELECT] select-cols[] insert-cols[comments,marks,status,submission_id] update-cols[comments,marks,status]",
      "authenticated submissions table[SELECT] select-cols[] insert-cols[child_age,child_name,consent_version,event_id,media_consent,parent_email,parent_mobile,parent_name] update-cols[child_age,child_name,event_id,media_consent,parent_email,parent_mobile,parent_name]",
      "authenticated user_roles table[DELETE,SELECT] select-cols[] insert-cols[role,user_id] update-cols[role]",
      "authenticated winners table[DELETE,INSERT,SELECT,UPDATE] select-cols[] insert-cols[] update-cols[]",
      ].sort(),
    );
  });

  it("functions: nothing is executable by PUBLIC or anon; authenticated gets only the listed ones", async () => {
    await actAs(db, "superuser");
    const res = await db.query<{ sig: string; pub: boolean; anon: boolean; authed: boolean }>(`
      select p.pronamespace::regnamespace::text || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
        (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')) as pub,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed
      from pg_proc p
      where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
      order by 1`);
    expect(res.rows.filter((r) => r.pub)).toEqual([]);
    expect(res.rows.filter((r) => r.anon)).toEqual([]);
    expect(res.rows.filter((r) => r.authed).map((r) => r.sig)).toEqual([
      "private.is_admin()",
      "private.is_judge()",
      "private.is_staff()",
      "private.judge_can_score(p_submission uuid)",
      "public.assign_judge_to_event(p_judge uuid, p_event smallint)",
      "public.unlock_score(p_id uuid)",
      "public.withdraw_submission(p_id uuid)",
    ]);
  });

  it("the private schema is usable only by authenticated (for policies), never by anon or PUBLIC", async () => {
    await actAs(db, "superuser");
    const res = await db.query<{ anon: boolean; authed: boolean }>(
      "select has_schema_privilege('anon', 'private', 'USAGE') as anon, has_schema_privilege('authenticated', 'private', 'USAGE') as authed",
    );
    expect(res.rows[0]).toEqual({ anon: false, authed: true });
  });
});

describe("engine and Supabase advisor-style checks", () => {
  it("runs on Postgres 17 or newer (the version pinned in supabase/config.toml)", async () => {
    await actAs(db, "superuser");
    const res = await db.query<{ v: string }>("select current_setting('server_version_num')::int as v");
    expect(Number(res.rows[0]!.v)).toBeGreaterThanOrEqual(170000);
  });

  it("every SECURITY DEFINER function pins an empty search_path and is owned by the migration role", async () => {
    await actAs(db, "superuser");
    const res = await db.query<{ sig: string; cfg: string[] | null; owner: string }>(`
      select p.pronamespace::regnamespace::text || '.' || p.proname as sig, p.proconfig as cfg, pg_get_userbyid(p.proowner) as owner
      from pg_proc p
      where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prosecdef`);
    expect(res.rows.length).toBeGreaterThanOrEqual(15);
    for (const r of res.rows) {
      expect(r.cfg ?? [], r.sig).toContain('search_path=""');
      expect(r.owner, r.sig).toBe("postgres");
    }
  });

  it("the two projection views are security_barrier and are the only views in public", async () => {
    await actAs(db, "superuser");
    const res = await db.query<{ relname: string; opts: string[] | null }>(
      "select relname, reloptions as opts from pg_class where relnamespace = 'public'::regnamespace and relkind = 'v' order by 1",
    );
    expect(res.rows.map((r) => r.relname)).toEqual(["judge_entries", "published_winners"]);
    for (const r of res.rows) expect(r.opts ?? [], r.relname).toContain("security_barrier=true");
  });

  it("policies evaluate auth.uid() and the role helpers once per statement, not per row", async () => {
    await actAs(db, "superuser");
    const res = await db.query<{ tablename: string; policyname: string; qual: string | null; with_check: string | null }>(
      "select tablename, policyname, qual, with_check from pg_policies where schemaname = 'public'",
    );
    const wrapped = /\(\s*SELECT\s+(auth\.uid|private\.is_admin|private\.is_judge|private\.is_staff)\(\)\s+AS\s+\w+\s*\)/gi;
    for (const p of res.rows) {
      const text = `${p.qual ?? ""} ${p.with_check ?? ""}`.replace(wrapped, "");
      expect(text, `${p.tablename}.${p.policyname}`).not.toMatch(/auth\.uid\(\)|private\.is_(admin|judge|staff)\(\)/i);
    }
  });

  it("has at most one permissive policy per table, role and action", async () => {
    await actAs(db, "superuser");
    const res = await db.query<{ tablename: string; cmd: string; roles: string }>(
      "select tablename, cmd, roles::text as roles from pg_policies where schemaname = 'public' and permissive = 'PERMISSIVE'",
    );
    const seen = new Map<string, number>();
    for (const p of res.rows) {
      const actions = p.cmd === "ALL" ? ["SELECT", "INSERT", "UPDATE", "DELETE"] : [p.cmd];
      for (const a of actions) for (const role of p.roles.replace(/[{}]/g, "").split(",")) {
        const key = `${p.tablename}|${role}|${a}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    expect([...seen].filter(([, n]) => n > 1).map(([k]) => k)).toEqual([]);
  });

  it("indexes every foreign key used in joins; only audit-only columns are left unindexed", async () => {
    await actAs(db, "superuser");
    const res = await db.query<{ col: string }>(`
      select c.conrelid::regclass::text || '.' || a.attname as col
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace
        and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])
      order by 1`);
    expect(res.rows.map((r) => r.col)).toEqual(["judge_assignments.assigned_by", "user_roles.granted_by", "winners.approved_by"]);
  });
});

describe("recovery script (dev only)", () => {
  it("removes everything M2 created, restores Supabase default privileges, and migrations can be replayed", async () => {
    const scratch = await createDb();
    try {
      const rollback = readFileSync(join(import.meta.dirname, "..", "recovery", "rollback_m2_dev_only.sql"), "utf8");
      await scratch.exec(rollback);
      const left = await scratch.query<{ n: string }>(`
        select count(*) as n from (
          select 1 from pg_class where relnamespace = 'public'::regnamespace
          union all select 1 from pg_proc where pronamespace = 'public'::regnamespace
          union all select 1 from pg_namespace where nspname = 'private') x`);
      expect(Number(left.rows[0]!.n)).toBe(0);

      const bare = await createBareDb();
      const acl = (d: PGlite) =>
        d.query<{ a: string }>("select defaclobjtype::text || ':' || defaclacl::text as a from pg_default_acl order by 1");
      expect((await acl(scratch)).rows).toEqual((await acl(bare)).rows);
      await bare.close();

      await applyMigrations(scratch); // the same three files apply cleanly again
      const events = await scratch.query<{ n: string }>("select count(*) as n from public.events");
      expect(Number(events.rows[0]!.n)).toBe(6);
    } finally {
      await scratch.close();
    }
  });
});

describe("judge projection (static check of the view definition)", () => {
  it("never references a child or parent column, and reads submissions only through four non-personal columns", async () => {
    await actAs(db, "superuser");
    const res = await db.query<{ def: string }>("select pg_get_viewdef('public.judge_entries'::regclass, true) as def");
    const def = res.rows[0]!.def;
    expect(def).not.toMatch(/parent_|child_|consent|owner_id|video_size|email|mobile|phone/i);
    const submissionColumns = [...def.matchAll(/\bs\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(submissionColumns)].sort()).toEqual(["entry_code", "event_id", "id", "status", "video_key"]);
  });
});
