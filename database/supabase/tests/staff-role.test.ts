import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { staffLogin } from "../../../admin/lib/staff/login";
import { ids, q, setupDb, type Who } from "./helpers";

// The role lookup behind staff sign-in, run against the REAL migrations and row level security as each kind of user. The query
// builder is a thin adapter that runs the same select as the signed-in person (PostgREST would do the same).

vi.mock("../../../admin/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("next/navigation", () => ({ redirect: () => undefined, notFound: () => undefined }));
const { staffRole } = await import("../../../admin/lib/staff/auth");

const db = setupDb();
const clientFor = (who: Who) =>
  ({
    from: (table: string) => ({
      select: (cols: string) => ({
        eq: (col: string, val: string) => ({
          maybeSingle: async () => {
            const rows = await q<Record<string, unknown>>(db(), who, `select ${cols} from public.${table} where ${col} = $1`, [val]);
            return { data: rows[0] ?? null, error: null };
          },
        }),
      }),
    }),
  }) as unknown as SupabaseClient;

describe("staffRole with real row level security", () => {
  it("an administrator is an admin and an active judge is a judge, each asking about themselves", async () => {
    expect(await staffRole(clientFor("admin"), ids.admin)).toBe("admin");
    expect(await staffRole(clientFor("judge1"), ids.judge1)).toBe("judge");
  });

  it("a parent, and any account with no role, is nobody", async () => {
    expect(await staffRole(clientFor("parentA"), ids.parentA)).toBeNull();
    expect(await staffRole(clientFor("stranger"), ids.stranger)).toBeNull();
  });

  it("a deactivated judge is nobody, and is a judge again once reactivated", async () => {
    await q(db(), "superuser", "update public.judge_profiles set active = false where user_id = $1", [ids.judge2]);
    expect(await staffRole(clientFor("judge2"), ids.judge2)).toBeNull();
    await q(db(), "superuser", "update public.judge_profiles set active = true where user_id = $1", [ids.judge2]);
    expect(await staffRole(clientFor("judge2"), ids.judge2)).toBe("judge");
  });

  it("a person cannot learn or borrow someone else's role: a judge or parent asking about the administrator gets nothing", async () => {
    expect(await staffRole(clientFor("judge1"), ids.admin)).toBeNull();
    expect(await staffRole(clientFor("parentA"), ids.admin)).toBeNull();
    expect(await staffRole(clientFor("parentA"), ids.judge1)).toBeNull();
  });

  it("a role claimed in token metadata does not count: only the user_roles table does", async () => {
    await q(db(), "superuser", "select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids.stranger, role: "authenticated", user_metadata: { role: "admin" }, app_metadata: { role: "admin" } })]);
    const claimed = {
      from: (table: string) => ({
        select: (cols: string) => ({
          eq: (col: string, val: string) => ({
            maybeSingle: async () => {
              await q(db(), "superuser", "set local role authenticated");
              const res = await db().query(`select ${cols} from public.${table} where ${col} = $1`, [val]);
              return { data: res.rows[0] ?? null, error: null };
            },
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    expect(await staffRole(claimed, ids.stranger)).toBeNull();
  });

  it("with no session at all (anon) the lookup is refused by the database, which the sign-in treats as 'no access'", async () => {
    await expect(staffRole(clientFor("anon"), ids.admin)).rejects.toBeDefined();
  });
});

describe("staff sign-in end to end over the real role tables", () => {
  const login = (who: Who, userId: string) =>
    staffLogin(
      {
        signIn: async () => ({ userId }), // the password step is Supabase Auth's; here it has succeeded
        roleOf: (id) => staffRole(clientFor(who), id),
        signOut: async () => undefined,
      },
      { email: "someone@example.org", password: "a-long-enough-password-1" },
    );

  it("admin and active judge get in, with the right destination role", async () => {
    expect(await login("admin", ids.admin)).toEqual({ ok: true, role: "admin" });
    expect(await login("judge1", ids.judge1)).toEqual({ ok: true, role: "judge" });
  });
  it("parent, role-less account and inactive judge are denied", async () => {
    expect(await login("parentA", ids.parentA)).toEqual({ ok: false, code: "notStaff" });
    expect(await login("stranger", ids.stranger)).toEqual({ ok: false, code: "notStaff" });
    await q(db(), "superuser", "update public.judge_profiles set active = false where user_id = $1", [ids.judge1]);
    expect(await login("judge1", ids.judge1)).toEqual({ ok: false, code: "notStaff" });
  });
  it("an anonymous database session is denied rather than crashing", async () => {
    expect(await login("anon", ids.admin)).toEqual({ ok: false, code: "notStaff" });
  });
});
