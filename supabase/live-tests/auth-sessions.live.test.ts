// Live security tests: real Supabase Auth sessions through the real Data API (PostgREST) and real RLS.
//
// NOT part of `npm test`. Run only with `npm run test:live` against the DEV project (or a local
// `supabase start` stack) after the three M2 migrations are applied there. scripts/db-dev.ts refuses the
// production project, a URL that disagrees with RIO_DEV_PROJECT_REF, and keys of the wrong kind.
//
// What authorizes what:
//   * Every permission assertion is made with a real user JWT (signInWithPassword) or with the publishable
//     key and no session (anonymous). The secret key exists only inside createSetup(): it creates the dummy
//     users, fixtures and baseline, and does the cleanup. A test below checks that this stays true.
//
// What it writes (all tagged with a unique run id, all removed afterwards):
//   * 8 dummy auth users  <run>-<name>@example.test  (random passwords, never printed)
//   * roles/profiles for the dummy judges and admins, a few dummy submissions, scores, assignments, one winner
//   * temporary changes to event_settings (open window, consent version), restored from a baseline snapshot
// What it never touches: the six seeded events, any row not owned by or tied to a dummy user, production.
// Cleanup is limited to ids collected during the run; afterwards the table counts, the events and the
// settings are compared with the baseline taken before anything was written.
//
// REQUIRES migrations 00100 to 00600 (M4B.2): final submission no longer exists as a parent-callable function. Fixtures reach
// "finalized" through the same service-role functions the app uses (issue_video_upload, attach_video_upload,
// finalize_verified_submission), with SYNTHETIC verified values: no bucket and no real video is involved here. Tests that need a
// real R2 object belong to the separate, approval-gated live upload suite (e2e-live), never to this file.
//
// STATUS: the earlier version passed 25 of 25 on DEV (M2.4); this revised version has NOT been executed (UNVERIFIED until a run passes).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeLiveTarget, readProductionPublishableKey, readProductionRef } from "../../scripts/db-dev";

const target = assertSafeLiveTarget(process.env, readProductionRef(), readProductionPublishableKey());
const run = `m24${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const opts = { auth: { persistSession: false, autoRefreshToken: false } } as const;
const anonClient = () => createClient(target.url, target.publishableKey, opts);

type Who = "parentA" | "parentB" | "judge1" | "judge2" | "admin1" | "admin2" | "stranger" | "metaAdmin";
const users = {} as Record<Who, { id: string; email: string; client: SupabaseClient }>;
const TABLES = ["events", "event_settings", "user_roles", "judge_profiles", "submissions", "video_uploads", "judge_assignments", "scores", "winners", "audit_log"] as const;
// Functions that only the trusted server path (service role) may call, and the one that no longer exists.
const SERVER_ONLY_FUNCTIONS = ["check_finalize", "finalize_verified_submission"] as const;
const NOT_CALLABLE = ["42501", "PGRST202"]; // refused by permission, or invisible to the API: either way the caller cannot run it
const NOT_FOUND_AT_ALL = ["PGRST202", "42883"];
const FAKE_UPLOAD = { bytes: 20 * 1024 * 1024, type: "video/mp4" } as const;
const serverOnlyArgs = (fn: (typeof SERVER_ONLY_FUNCTIONS)[number], owner: string, submission: string) =>
  fn === "check_finalize"
    ? { p_owner: owner, p_submission: submission }
    : { p_owner: owner, p_submission: submission, p_upload: randomUUID(), p_bytes: FAKE_UPLOAD.bytes, p_content_type: FAKE_UPLOAD.type, p_etag: "x" };
const mobile = (lead: number) => `${lead}${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;

// Distinctive personal data: any leak to a judge or another parent is detected by searching for these.
const PII = { childName: `Zorathustra-${run}`, parentName: `Ottoline-${run}`, email: `ottoline.${run}@example.test`, mobile: mobile(9) };
const NEEDLES = [PII.childName, PII.parentName, PII.email, PII.mobile];
const leaks = (value: unknown) => NEEDLES.some((n) => JSON.stringify(value ?? "").includes(n));

const claims = (token: string) => JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
const FLOOR_MINUS_ONE_MIN = "2026-11-13T23:59:00+05:30"; // one minute before results may be published
const FAR_FUTURE = "2099-01-01T00:00:00+05:30";

// ---------------------------------------------------------------------------------------------
// Setup and cleanup: the ONLY place the secret key is used.
// ---------------------------------------------------------------------------------------------
type Snapshot = { counts: Record<string, number>; events: unknown; settings: Record<string, unknown> };

function createSetup() {
  const service = createClient(target.url, target.secretKey, opts);
  const created = { userIds: [] as string[], submissionIds: [] as string[] };
  let baseline: Snapshot | null = null;
  const leftovers: string[] = [];

  const must = async <T>(p: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<T> => {
    const { data, error } = await p;
    if (error) throw new Error(`${what}: ${error.message}`);
    return data;
  };

  async function snapshot(): Promise<Snapshot> {
    const counts: Record<string, number> = {};
    for (const t of TABLES) {
      const { count, error } = await service.from(t).select("*", { count: "exact", head: true });
      if (error) throw new Error(`snapshot ${t}: ${error.message}`);
      counts[t] = count ?? 0;
    }
    const events = await must(service.from("events").select("*").order("id"), "snapshot events");
    const settings = await must(service.from("event_settings").select("submissions_open_at, submissions_close_at, current_consent_version, results_publish_at").single(), "snapshot settings");
    return { counts, events, settings: settings as Record<string, unknown> };
  }

  async function makeUser(name: Who, extra: Record<string, unknown> = {}) {
    const email = `${run}-${name.toLowerCase()}@example.test`;
    const password = `Pw-${randomUUID()}`; // random, test-only, never printed
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true, ...extra });
    if (error || !data.user) throw new Error(`createUser(${name}) failed: ${error?.message}`);
    created.userIds.push(data.user.id);
    const client = anonClient();
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`signIn(${name}) failed: ${signIn.error.message}`);
    users[name] = { id: data.user.id, email, client };
  }

  async function insertSubmission(owner: Who, childName: string, mobileNo: string, email: string, event: number, age: number): Promise<string> {
    const row = await must(
      service.from("submissions").insert({
        owner_id: users[owner].id, event_id: event, child_name: childName, child_age: age, parent_name: owner === "parentA" ? PII.parentName : `Bertram-${run}`,
        parent_email: email, parent_mobile: mobileNo, consent_version: "live-test",
      }).select("id").single(),
      "insert submission",
    );
    created.submissionIds.push(row!.id);
    return row!.id;
  }
  // The same two steps the app takes after a real upload, with synthetic verified values (no bucket is involved).
  const uploads = new Map<string, { uploadId: string; etag: string }>();
  const verifiedUpload = async (owner: Who, id: string) => {
    const issued = await must(service.rpc("issue_video_upload", { p_owner: users[owner].id, p_submission: id, p_content_type: FAKE_UPLOAD.type, p_bytes: FAKE_UPLOAD.bytes }), "issue upload");
    const uploadId = (issued as { upload_id: string }[])[0]!.upload_id;
    const etag = `"live-${randomUUID()}"`;
    await must(service.rpc("attach_video_upload", { p_owner: users[owner].id, p_upload: uploadId, p_bytes: FAKE_UPLOAD.bytes, p_content_type: FAKE_UPLOAD.type, p_etag: etag }), "attach upload");
    uploads.set(id, { uploadId, etag });
  };
  const recordFor = (id: string, over: { etag?: string; bytes?: number; type?: string } = {}) => {
    const u = uploads.get(id);
    if (!u) throw new Error("no verified upload was recorded for this entry");
    return { p_upload: u.uploadId, p_bytes: over.bytes ?? FAKE_UPLOAD.bytes, p_content_type: over.type ?? FAKE_UPLOAD.type, p_etag: over.etag ?? u.etag };
  };
  /** The trusted server path, simulated at database level. Returns the raw result so tests can assert refusals. */
  const trusted = {
    check: (owner: Who, id: string) => service.rpc("check_finalize", { p_owner: users[owner].id, p_submission: id }),
    finalize: (owner: Who, id: string, over: { etag?: string; bytes?: number; type?: string } = {}) =>
      service.rpc("finalize_verified_submission", { p_owner: users[owner].id, p_submission: id, ...recordFor(id, over) }),
  };

  return {
    async begin() {
      baseline = await snapshot();
      if (baseline.counts.events !== 6) throw new Error("Refusing to run: the dev database does not hold exactly the six seeded events.");
    },
    makeUser,
    trusted,
    async grantStaff() {
      await must(service.from("user_roles").insert([
        { user_id: users.admin1.id, role: "admin" }, { user_id: users.admin2.id, role: "admin" },
        { user_id: users.judge1.id, role: "judge" }, { user_id: users.judge2.id, role: "judge" },
      ]), "roles");
      await must(service.from("judge_profiles").insert([
        { user_id: users.judge1.id, display_name: `Judge One ${run}` }, { user_id: users.judge2.id, display_name: `Judge Two ${run}` },
      ]), "judge profiles");
    },
    async openRegistration() {
      await must(service.from("event_settings").update({
        submissions_open_at: new Date(Date.now() - 3_600_000).toISOString(),
        submissions_close_at: new Date(Date.now() + 6 * 3_600_000).toISOString(),
        current_consent_version: "live-test",
      }).eq("id", true).select(), "open window");
    },
    async finalizedEntry(owner: Who, childName: string, mobileNo: string, email: string, event = 3): Promise<string> {
      const id = await insertSubmission(owner, childName, mobileNo, email, event, 9);
      await verifiedUpload(owner, id);
      await must(trusted.finalize(owner, id), "finalize through the trusted path");
      return id;
    },
    async uploadedEntry(owner: Who, childName: string, mobileNo: string, email: string, event = 5): Promise<string> {
      const id = await insertSubmission(owner, childName, mobileNo, email, event, 9);
      await verifiedUpload(owner, id);
      return id;
    },
    async assign(judge: Who, submissionId: string) {
      await must(service.from("judge_assignments").insert({ judge_id: users[judge].id, submission_id: submissionId }), "assign");
    },
    /** Remove ONLY what this run created, then compare with the baseline. Returns problems found. */
    async cleanup(): Promise<string[]> {
      const problems: string[] = [];
      const ids = created.userIds;
      const attempt = async (what: string, p: PromiseLike<{ error: { message: string } | null }>) => {
        const { error } = await p;
        if (error) problems.push(`${what}: ${error.message}`);
      };
      if (ids.length) {
        const { data: owned } = await service.from("submissions").select("id").in("owner_id", ids);
        const subIds = [...new Set([...created.submissionIds, ...(owned ?? []).map((r: { id: string }) => r.id)])];
        if (subIds.length) {
          await attempt("winners", service.from("winners").delete().in("submission_id", subIds));
          await attempt("scores", service.from("scores").delete().in("submission_id", subIds));
          await attempt("assignments", service.from("judge_assignments").delete().in("submission_id", subIds));
          await attempt("submissions", service.from("submissions").delete().in("id", subIds));
        }
        await attempt("scores by judge", service.from("scores").delete().in("judge_id", ids));
        await attempt("judge profiles", service.from("judge_profiles").delete().in("user_id", ids));
        const staffIds = [users.judge1, users.judge2, users.stranger].filter(Boolean).map((u) => u.id);
        if (staffIds.length) await attempt("judge/other roles", service.from("user_roles").delete().in("user_id", staffIds));
        // Administrators last: the database refuses to remove the last administrator.
        for (const who of ["admin2", "admin1"] as const) {
          const u = users[who];
          if (!u) continue;
          const { error } = await service.from("user_roles").delete().eq("user_id", u.id);
          if (error) {
            leftovers.push(who);
            await service.auth.admin.updateUserById(u.id, { ban_duration: "876000h", password: `Pw-${randomUUID()}` });
          }
        }
        for (const id of ids) {
          if (leftovers.some((l) => users[l as Who]?.id === id)) continue;
          await attempt("auth user", service.auth.admin.deleteUser(id));
        }
      }
      if (baseline) {
        await attempt("settings restore", service.from("event_settings").update(baseline.settings).eq("id", true));
        const after = await snapshot();
        for (const t of TABLES) {
          const allowedGrowth = t === "audit_log" ? after.counts[t]! - baseline.counts[t]! : t === "user_roles" ? leftovers.length : 0;
          if (after.counts[t] !== baseline.counts[t]! + allowedGrowth) problems.push(`row count changed in ${t}`);
        }
        if (JSON.stringify(after.events) !== JSON.stringify(baseline.events)) problems.push("the six seeded events changed");
        if (JSON.stringify(after.settings) !== JSON.stringify(baseline.settings)) problems.push("event_settings were not restored");
      }
      if (leftovers.length) problems.push(`left in place (banned, random password): ${leftovers.join(", ")}; the last administrator cannot be removed, delete it once a real administrator exists`);
      return problems;
    },
  };
}

const setup = createSetup();
let entryId = ""; // finalized, owned by parentA, assigned to judge1
let otherEntryId = ""; // finalized, owned by parentB, assigned to nobody
let draftId = ""; // draft registered by parentA through the API

beforeAll(async () => {
  await setup.begin();
  for (const name of ["parentA", "parentB", "judge1", "judge2", "admin1", "admin2", "stranger"] as const) await setup.makeUser(name);
  // a user who claims admin in token metadata must still be nobody
  await setup.makeUser("metaAdmin", { user_metadata: { role: "admin" }, app_metadata: { role: "admin" } });
  await setup.grantStaff();
  await setup.openRegistration();
  entryId = await setup.finalizedEntry("parentA", PII.childName, PII.mobile, PII.email);
  otherEntryId = await setup.finalizedEntry("parentB", `Other-${run}`, mobile(8), `other.${run}@example.test`);
  await setup.assign("judge1", entryId);
  const draft = await users.parentA.client.from("submissions").insert({
    event_id: 2, child_name: `Draft-${run}`, child_age: 6, parent_name: `P-${run}`, parent_email: `draft.${run}@example.test`, parent_mobile: mobile(7), consent_version: "live-test",
  }).select("id").single();
  if (draft.error) throw new Error(`parentA could not register a draft through the API: ${draft.error.message}`);
  draftId = draft.data.id;
}, 180_000);

afterAll(async () => {
  const problems = await setup.cleanup();
  if (problems.length) console.warn(`[live-tests cleanup] ${problems.join(" | ")}`);
  const hard = problems.filter((p) => !p.startsWith("left in place"));
  if (hard.length) throw new Error(`Cleanup verification failed: ${hard.join(" | ")}`);
}, 180_000);

const HIDDEN_FROM_ANON = ["submissions", "scores", "judge_assignments", "judge_profiles", "user_roles", "winners", "audit_log", "judge_entries"];

describe("test harness", () => {
  it("every permission assertion uses a real user JWT or the anonymous key, never the secret key", async () => {
    for (const [name, u] of Object.entries(users)) {
      const token = (await u.client.auth.getSession()).data.session?.access_token;
      expect(token, name).toBeTruthy();
      const c = claims(token!);
      expect(c.role, name).toBe("authenticated");
      expect(c.sub, name).toBe(u.id);
    }
    expect((await anonClient().auth.getSession()).data.session).toBeNull();
    // the secret key is referenced exactly once in this file: where the setup client is created
    const source = readFileSync(import.meta.filename, "utf8");
    expect(source.match(/target\.secretKey/g)?.length).toBe(1);
  });

  it("starts from the baseline: six events and eight dummy users", async () => {
    expect((await anonClient().from("events").select("id")).data).toHaveLength(6);
    expect(Object.keys(users)).toHaveLength(8);
  });
});

describe("anonymous (publishable key, no session)", () => {
  it("can read the six events, settings and the published-winners view", async () => {
    const events = await anonClient().from("events").select("id, slug").order("id");
    expect(events.data?.map((e) => e.slug)).toEqual(["malalai-mozhi", "kathai-sollum-kutties", "thirukkural-thiramai", "kutti-pesalar", "tamil-kalaikoodam", "tamilil-sollu"]);
    expect((await anonClient().from("event_settings").select("*")).data).toHaveLength(1);
    expect((await anonClient().from("published_winners").select("*")).error).toBeNull();
  });

  it("is refused on every personal or internal relation (unauthenticated submission access denied)", async () => {
    for (const table of HIDDEN_FROM_ANON) {
      const { data, error } = await anonClient().from(table).select("*");
      expect(error?.code, table).toBe("42501");
      expect(data, table).toBeNull();
    }
    const insert = await anonClient().from("submissions").insert({ event_id: 1, child_name: "x", child_age: 4, parent_name: "x", parent_email: "x@example.test", parent_mobile: "9876543210", consent_version: "live-test" });
    expect(insert.error?.code).toBe("42501");
  });

  it("cannot call RPCs or reach the private schema", async () => {
    for (const fn of ["withdraw_submission", "unlock_score"]) {
      expect((await anonClient().rpc(fn, { p_id: randomUUID() })).error?.code, fn).toBe("42501");
    }
    for (const fn of SERVER_ONLY_FUNCTIONS) {
      expect(NOT_CALLABLE, fn).toContain((await anonClient().rpc(fn, serverOnlyArgs(fn, randomUUID(), randomUUID()))).error?.code);
    }
    expect(NOT_FOUND_AT_ALL, "finalize_submission").toContain((await anonClient().rpc("finalize_submission", { p_id: randomUUID() })).error?.code);
    const priv = await fetch(`${target.url}/rest/v1/events?select=id&limit=1`, { headers: { apikey: target.publishableKey, "Accept-Profile": "private" } });
    expect(priv.status).toBe(406);
    const helper = await fetch(`${target.url}/rest/v1/rpc/is_admin`, { method: "POST", headers: { apikey: target.publishableKey, "Content-Type": "application/json" }, body: "{}" });
    expect(helper.status).toBe(404);
  });
});

describe("the six seeded events are read-only for everyone", () => {
  it("rejects every write to events, even from an administrator, and leaves them unchanged", async () => {
    const before = await anonClient().from("events").select("*").order("id");
    const callers = [["anon", anonClient()], ["stranger", users.stranger.client], ["parentA", users.parentA.client], ["judge1", users.judge1.client], ["admin1", users.admin1.client]] as const;
    for (const [name, client] of callers) {
      expect((await client.from("events").insert({ id: 90, slug: "x", name_ta: "x", name_en: "x", min_age: 3, max_age: 4 })).error?.code, `${name} insert`).toBe("42501");
      expect((await client.from("events").update({ name_en: "hacked" }).eq("id", 1)).error?.code, `${name} update`).toBe("42501");
      expect((await client.from("events").delete().eq("id", 1)).error?.code, `${name} delete`).toBe("42501");
    }
    expect((await anonClient().from("events").select("*").order("id")).data).toEqual(before.data);
  });
});

describe("unauthorized signed-in users (no role)", () => {
  it("see public data only and cannot grant themselves anything", async () => {
    for (const who of ["stranger", "metaAdmin"] as const) {
      const c = users[who].client;
      for (const table of ["submissions", "scores", "judge_assignments", "judge_profiles", "winners", "audit_log", "judge_entries", "user_roles"]) {
        const { data, error } = await c.from(table).select("*");
        expect(error, `${who}.${table}`).toBeNull();
        expect(data, `${who}.${table}`).toEqual([]);
      }
      expect((await c.from("user_roles").insert({ user_id: users[who].id, role: "admin" })).error?.code, who).toBe("42501");
      expect((await c.from("judge_profiles").insert({ user_id: users[who].id, display_name: "x" })).error?.code, who).toBe("42501");
      expect((await c.rpc("unlock_score", { p_id: randomUUID() })).error?.message, who).toContain("forbidden");
    }
  });
});

describe("parents", () => {
  it("register through RLS: owner and draft status are set by the database", async () => {
    const res = await users.stranger.client.from("submissions").insert({
      event_id: 2, child_name: `Kid-${run}`, child_age: 6, parent_name: `P-${run}`, parent_email: `p.${run}@example.test`, parent_mobile: mobile(6), consent_version: "live-test",
    }).select("owner_id, status, entry_code").single();
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ owner_id: users.stranger.id, status: "draft" });
  });

  it("cannot set protected columns, use a stale consent version, or register as staff", async () => {
    const base = { event_id: 2, child_name: "x", child_age: 6, parent_name: "x", parent_email: "x@example.test", parent_mobile: mobile(9) };
    expect((await users.parentB.client.from("submissions").insert({ ...base, consent_version: "live-test", status: "finalized" })).error?.code).toBe("42501");
    expect((await users.parentB.client.from("submissions").insert({ ...base, consent_version: "live-test", owner_id: users.parentA.id })).error?.code).toBe("42501");
    expect((await users.parentB.client.from("submissions").insert({ ...base, consent_version: "old" })).error?.message).toContain("consent_version_mismatch");
    expect((await users.judge1.client.from("submissions").insert({ ...base, consent_version: "live-test" })).error?.code).toBe("42501");
    expect((await users.admin1.client.from("submissions").insert({ ...base, consent_version: "live-test" })).error?.code).toBe("42501");
  });

  it("see only their own entries; another parent's entry is invisible even when asked for by id", async () => {
    const a = await users.parentA.client.from("submissions").select("id");
    expect(a.data?.map((r) => r.id)).toEqual(expect.arrayContaining([entryId, draftId]));
    expect(a.data?.map((r) => r.id)).not.toContain(otherEntryId);
    const b = await users.parentB.client.from("submissions").select("*").eq("id", entryId);
    expect(b.error).toBeNull();
    expect(b.data).toEqual([]);
    expect(leaks((await users.parentB.client.from("submissions").select("*")).data)).toBe(false);
  });

  it("cannot update, delete, withdraw or finalize another parent's entry (cross-parent writes denied)", async () => {
    const upd = await users.parentB.client.from("submissions").update({ child_name: "Hacked" }).eq("id", draftId).select();
    expect(upd.error).toBeNull();
    expect(upd.data).toEqual([]);
    expect((await users.parentB.client.from("submissions").delete().eq("id", draftId)).error?.code).toBe("42501");
    expect((await users.parentB.client.rpc("withdraw_submission", { p_id: draftId })).error?.message).toBe("not_found");
    const still = await users.parentA.client.from("submissions").select("child_name, status").eq("id", draftId).single();
    expect(still.data).toEqual({ child_name: `Draft-${run}`, status: "draft" });
  });

  it("can edit their own draft but not status, video_key, owner or consent; cannot delete; finalized entries are locked", async () => {
    const ok = await users.parentA.client.from("submissions").update({ child_name: `Draft-${run}-edited` }).eq("id", draftId).select();
    expect(ok.data).toHaveLength(1);
    for (const patch of [{ status: "finalized" }, { video_key: randomUUID() }, { owner_id: users.parentB.id }, { consent_at: new Date().toISOString() }, { entry_code: "X" }]) {
      expect((await users.parentA.client.from("submissions").update(patch).eq("id", draftId)).error?.code, JSON.stringify(Object.keys(patch))).toBe("42501");
    }
    expect((await users.parentA.client.from("submissions").delete().eq("id", draftId)).error?.code).toBe("42501");
    const locked = await users.parentA.client.from("submissions").update({ child_name: "late" }).eq("id", entryId).select();
    expect(locked.data).toEqual([]);
  });

  it("cannot finalize anything themselves: the old finalizer is gone and the new functions are server-only", async () => {
    const mine = await setup.uploadedEntry("parentB", `Kid-B-${run}`, mobile(8), `kidb.${run}@example.test`);
    const client = users.parentB.client;
    // the removed parent-callable finalizer
    expect(NOT_FOUND_AT_ALL).toContain((await client.rpc("finalize_submission", { p_id: mine })).error?.code);
    // the server-only functions, called with correct arguments for the parent's OWN uploaded entry
    for (const fn of SERVER_ONLY_FUNCTIONS) {
      const res = await client.rpc(fn, serverOnlyArgs(fn, users.parentB.id, mine));
      expect(NOT_CALLABLE, fn).toContain(res.error?.code);
      expect(res.data, fn).toBeNull();
    }
    // and by writing the status directly
    expect((await client.from("submissions").update({ status: "finalized" }).eq("id", mine)).error?.code).toBe("42501");
    expect((await client.from("submissions").select("status").eq("id", mine).single()).data).toEqual({ status: "uploaded" });
    // another parent calling it for this entry is no different
    for (const fn of SERVER_ONLY_FUNCTIONS) {
      const res = await users.parentA.client.rpc(fn, serverOnlyArgs(fn, users.parentB.id, mine));
      expect(NOT_CALLABLE, fn).toContain(res.error?.code);
    }
  });
});

describe("final submission through the trusted server path (database level, synthetic verified values, no bucket)", () => {
  it("refuses another parent's entry exactly like a missing one, and a changed object, and changes nothing", async () => {
    const mine = await setup.uploadedEntry("parentB", `Kid-C-${run}`, mobile(8), `kidc.${run}@example.test`);
    const strangerView = await setup.trusted.check("parentA", mine);
    const missingView = await setup.trusted.check("parentA", randomUUID());
    expect(strangerView.error?.message).toBe("not_found");
    expect(strangerView.error?.message).toBe(missingView.error?.message);
    expect((await setup.trusted.finalize("parentA", mine)).error?.message).toBe("not_found");
    for (const over of [{ etag: '"replaced"' }, { bytes: FAKE_UPLOAD.bytes + 1 }, { type: "video/webm" }]) {
      expect((await setup.trusted.finalize("parentB", mine, over)).error?.message, JSON.stringify(over)).toBe("video_changed");
    }
    expect((await users.parentB.client.from("submissions").select("status").eq("id", mine).single()).data).toEqual({ status: "uploaded" });
  });

  it("finalizes an owned, uploaded, consented entry once; repeating it is answered, not repeated; the entry is then locked", async () => {
    const mine = await setup.uploadedEntry("parentB", `Kid-D-${run}`, mobile(8), `kidd.${run}@example.test`);
    const record = await setup.trusted.check("parentB", mine);
    expect(record.error).toBeNull();
    expect((record.data as { already: boolean }[])[0]!.already).toBe(false);
    expect((await setup.trusted.finalize("parentB", mine)).data).toBe("finalized");
    const first = (await users.parentB.client.from("submissions").select("status, finalized_at").eq("id", mine).single()).data;
    expect(first).toMatchObject({ status: "finalized" });
    expect((await setup.trusted.finalize("parentB", mine)).data).toBe("already_finalized");
    expect((await users.parentB.client.from("submissions").select("status, finalized_at").eq("id", mine).single()).data).toEqual(first);
    // locked for the parent: no edit, and withdrawal is irreversible for parents
    expect((await users.parentB.client.from("submissions").update({ child_name: "late" }).eq("id", mine).select()).data).toEqual([]);
    expect((await users.parentB.client.rpc("withdraw_submission", { p_id: mine })).error?.message).toBe("not_found");
  });

  it("gives a generic duplicate error for the same child twice, without leaking personal data", async () => {
    const twin = await setup.uploadedEntry("parentB", PII.childName, PII.mobile, `twin.${run}@example.test`, 5);
    const dup = await setup.trusted.finalize("parentB", twin);
    expect(dup.error?.code).toBe("23505");
    expect(dup.error?.message).toBe("duplicate_entry");
    expect(leaks(dup.error)).toBe(false);
    expect((await users.parentB.client.from("submissions").select("status").eq("id", twin).single()).data).toEqual({ status: "uploaded" });
  });
});

describe("judges", () => {
  it("get no rows from submissions, by any route", async () => {
    const all = await users.judge1.client.from("submissions").select("*");
    expect(all.error).toBeNull();
    expect(all.data).toEqual([]);
    expect((await users.judge1.client.from("submissions").select("*", { count: "exact", head: true })).count).toBe(0);
    expect((await users.judge1.client.from("submissions").select("parent_email").eq("id", entryId)).data).toEqual([]);
    // resource embedding runs as the caller, so RLS on submissions still applies
    for (const [table, select] of [["scores", "*, submissions(*)"], ["judge_entries", "*, submissions(*)"], ["judge_assignments", "*, submissions(*)"]] as const) {
      const { data, error } = await users.judge1.client.from(table).select(select);
      expect(leaks({ data, error }), table).toBe(false);
      if (!error) expect(JSON.stringify(data)).not.toMatch(/"submissions":\s*\{/);
    }
  });

  it("see only the safe projection of entries assigned to them", async () => {
    const res = await users.judge1.client.from("judge_entries").select("*");
    expect(res.error).toBeNull();
    expect(res.data?.map((r) => r.entry_id)).toEqual([entryId]);
    expect(Object.keys(res.data![0]!).sort()).toEqual(["entry_code", "entry_id", "event_id", "event_name_en", "event_name_ta", "my_comments", "my_marks", "score_id", "score_status", "video_key"]);
    expect(leaks(res.data)).toBe(false);
    expect((await users.judge2.client.from("judge_entries").select("*")).data).toEqual([]);
    expect((await users.judge1.client.from("judge_entries").select("*").eq("entry_id", otherEntryId)).data).toEqual([]);
  });

  it("find no personal data in any relation, error or RPC response they can reach", async () => {
    for (const t of ["events", "event_settings", "user_roles", "judge_profiles", "judge_assignments", "scores", "winners", "audit_log", "judge_entries", "published_winners"]) {
      const { data, error } = await users.judge1.client.from(t).select("*");
      expect(leaks({ data, error }), t).toBe(false);
    }
    for (const fn of ["withdraw_submission", "unlock_score"]) {
      expect(leaks((await users.judge1.client.rpc(fn, { p_id: entryId })).error), fn).toBe(false);
    }
    for (const fn of SERVER_ONLY_FUNCTIONS) {
      const res = await users.judge1.client.rpc(fn, serverOnlyArgs(fn, users.parentA.id, entryId));
      expect(NOT_CALLABLE, fn).toContain(res.error?.code);
      expect(leaks(res.error), fn).toBe(false);
    }
  });

  it("score only assigned entries, privately; other judges, parents and admins cannot change or read their marks", async () => {
    const mine = await users.judge1.client.from("scores").insert({ submission_id: entryId, marks: 72.5, status: "draft" }).select("id").single();
    expect(mine.error).toBeNull();
    const scoreId = mine.data!.id;

    expect((await users.judge1.client.from("scores").insert({ submission_id: otherEntryId, marks: 50 })).error?.code).toBe("42501"); // not assigned
    expect((await users.judge2.client.from("scores").insert({ submission_id: entryId, marks: 50 })).error?.code).toBe("42501"); // not assigned to judge2
    expect((await users.judge1.client.from("scores").insert({ submission_id: entryId, judge_id: users.judge2.id, marks: 50 })).error?.code).toBe("42501");
    expect((await users.parentA.client.from("scores").insert({ submission_id: entryId, marks: 100 })).error?.code).toBe("42501");

    expect((await users.judge2.client.from("scores").select("*")).data).toEqual([]);
    expect((await users.parentA.client.from("scores").select("*")).data).toEqual([]);
    expect((await users.judge2.client.from("scores").update({ marks: 1 }).eq("id", scoreId).select()).data).toEqual([]);
    expect((await users.admin1.client.from("scores").update({ marks: 1 }).eq("id", scoreId).select()).data).toEqual([]);
    expect((await users.judge1.client.from("scores").update({ submission_id: otherEntryId }).eq("id", scoreId)).error?.code).toBe("42501");
    expect((await users.judge1.client.from("scores").update({ judge_id: users.judge2.id }).eq("id", scoreId)).error?.code).toBe("42501");
    expect((await users.judge1.client.from("scores").insert({ submission_id: entryId, marks: 101 })).error).not.toBeNull();
    expect((await users.judge1.client.from("scores").insert({ submission_id: entryId, marks: -1 })).error).not.toBeNull();

    const fin = await users.judge1.client.from("scores").update({ status: "final" }).eq("id", scoreId).select();
    expect(fin.data).toHaveLength(1);
    for (const patch of [{ marks: 99 }, { status: "draft" }, { comments: "changed" }]) {
      expect((await users.judge1.client.from("scores").update(patch).eq("id", scoreId).select()).data, JSON.stringify(patch)).toEqual([]);
    }
    expect((await users.judge1.client.rpc("unlock_score", { p_id: scoreId })).error?.message).toContain("forbidden");
    const view = await users.judge1.client.from("judge_entries").select("my_marks, score_status").single();
    expect(Number(view.data?.my_marks)).toBe(72.5);

    // only an administrator can reopen it; the judge can then edit and finalize again
    expect((await users.admin1.client.rpc("unlock_score", { p_id: scoreId })).error).toBeNull();
    expect((await users.judge1.client.from("scores").update({ marks: 80 }).eq("id", scoreId).select()).data).toHaveLength(1);
    expect((await users.judge1.client.from("scores").update({ status: "final" }).eq("id", scoreId).select()).data).toHaveLength(1);
  });

  it("cannot manage assignments or see other judges' assignments and roles", async () => {
    expect((await users.judge1.client.from("judge_assignments").insert({ judge_id: users.judge1.id, submission_id: otherEntryId })).error?.code).toBe("42501");
    expect((await users.judge2.client.from("judge_assignments").select("*")).data).toEqual([]);
    expect((await users.judge1.client.from("user_roles").select("user_id")).data?.map((r) => r.user_id)).toEqual([users.judge1.id]);
    expect((await users.judge1.client.from("audit_log").select("*")).data).toEqual([]);
  });

  it("lose access when an administrator deactivates them", async () => {
    try {
      expect((await users.admin1.client.from("judge_profiles").update({ active: false }).eq("user_id", users.judge1.id).select()).data).toHaveLength(1);
      expect((await users.judge1.client.from("judge_entries").select("*")).data).toEqual([]);
      expect((await users.judge1.client.from("scores").insert({ submission_id: entryId, marks: 10 })).error?.code).toBe("42501");
    } finally {
      await users.admin1.client.from("judge_profiles").update({ active: true }).eq("user_id", users.judge1.id);
    }
    expect((await users.judge1.client.from("judge_entries").select("*")).data).toHaveLength(1);
  });
});

describe("role escalation attempts", () => {
  it("are denied for parents, judges, role-less users and users claiming admin in token metadata", async () => {
    for (const who of ["parentA", "judge1", "stranger", "metaAdmin"] as const) {
      const c = users[who].client;
      expect((await c.from("user_roles").insert({ user_id: users[who].id, role: "admin" })).error?.code, `${who} insert admin`).toBe("42501");
      expect((await c.from("user_roles").insert({ user_id: users[who].id, role: "judge" })).error?.code, `${who} insert judge`).toBe("42501");
      expect((await c.from("judge_profiles").insert({ user_id: users[who].id, display_name: "x" })).error?.code, `${who} profile`).toBe("42501");
      expect((await c.rpc("unlock_score", { p_id: randomUUID() })).error?.message, `${who} unlock`).toContain("forbidden");
    }
    expect((await users.judge1.client.from("user_roles").update({ role: "admin" }).eq("user_id", users.judge1.id).select()).data).toEqual([]);
    expect((await users.judge1.client.from("user_roles").delete().eq("user_id", users.judge2.id).select()).data).toEqual([]);
    expect((await users.parentA.client.from("event_settings").update({ current_consent_version: "evil" }).eq("id", true).select()).data).toEqual([]);
  });

  it("only an administrator can assign a role, and the database stamps who did it", async () => {
    // granted_by is not an insertable column, so even an administrator cannot name a different approver
    expect((await users.admin1.client.from("user_roles").insert({ user_id: users.stranger.id, role: "judge", granted_by: users.admin2.id })).error?.code).toBe("42501");
    const res = await users.admin1.client.from("user_roles").insert({ user_id: users.stranger.id, role: "judge" }).select("granted_by").single();
    expect(res.error).toBeNull();
    expect(res.data?.granted_by).toBe(users.admin1.id);
    expect((await users.stranger.client.from("user_roles").select("role")).data).toEqual([{ role: "judge" }]);
    expect((await users.admin1.client.from("user_roles").delete().eq("user_id", users.stranger.id).select()).data).toHaveLength(1);
  });
});

describe("winners and publication", () => {
  it("only an administrator can approve a winner; the approver is stamped by the database; it must match event and status", async () => {
    for (const who of ["parentA", "judge1", "stranger"] as const) {
      expect((await users[who].client.from("winners").insert({ event_id: 3, submission_id: entryId, rank: 1, display_name: "x" })).error?.code, who).toBe("42501");
    }
    expect((await users.admin1.client.from("winners").insert({ event_id: 1, submission_id: entryId, rank: 1, display_name: "x" })).error?.message).toContain("event_mismatch");
    expect((await users.admin1.client.from("winners").insert({ event_id: 2, submission_id: draftId, rank: 1, display_name: "x" })).error?.message).toContain("submission_not_finalized");
    const win = await users.admin1.client.from("winners").insert({ event_id: 3, submission_id: entryId, rank: 1, display_name: "Zora", approved_by: users.admin2.id }).select("approved_by").single();
    expect(win.error).toBeNull();
    expect(win.data?.approved_by).toBe(users.admin1.id);
  });

  it("stay inaccessible to the public until an administrator schedules publication", async () => {
    for (const [who, client] of [["anon", anonClient()], ["parentA", users.parentA.client], ["judge1", users.judge1.client], ["stranger", users.stranger.client]] as const) {
      expect((await client.from("published_winners").select("*")).data, who).toEqual([]);
    }
    expect((await anonClient().from("winners").select("*")).error?.code).toBe("42501");
    for (const who of ["parentA", "judge1", "stranger"] as const) expect((await users[who].client.from("winners").select("*")).data, who).toEqual([]);

    try {
      // a far-future publish time is valid but not yet reached: still hidden from everyone
      expect((await users.admin1.client.from("event_settings").update({ results_publish_at: FAR_FUTURE }).eq("id", true).select()).data).toHaveLength(1);
      for (const [who, client] of [["anon", anonClient()], ["parentA", users.parentA.client], ["judge1", users.judge1.client]] as const) {
        expect((await client.from("published_winners").select("*")).data, who).toEqual([]);
      }
    } finally {
      await users.admin1.client.from("event_settings").update({ results_publish_at: null }).eq("id", true);
    }
    expect((await anonClient().from("event_settings").select("results_publish_at").single()).data?.results_publish_at).toBeNull();
  });

  it("refuse publication before 14 November 2026, and refuse scheduling by anyone but an administrator", async () => {
    const early = await users.admin1.client.from("event_settings").update({ results_publish_at: FLOOR_MINUS_ONE_MIN }).eq("id", true).select();
    expect(early.error?.code).toBe("23514");
    expect(early.data).toBeNull();
    const badWindow = await users.admin1.client.from("event_settings").update({ submissions_close_at: "2000-01-01T00:00:00Z" }).eq("id", true).select();
    expect(badWindow.error?.code).toBe("23514");
    for (const [who, client] of [["parentA", users.parentA.client], ["judge1", users.judge1.client], ["stranger", users.stranger.client]] as const) {
      const attempt = await client.from("event_settings").update({ results_publish_at: FAR_FUTURE }).eq("id", true).select();
      expect(attempt.data, who).toEqual([]);
    }
    expect((await anonClient().from("event_settings").select("results_publish_at").single()).data?.results_publish_at).toBeNull();
    expect((await anonClient().from("event_settings").update({ results_publish_at: FAR_FUTURE }).eq("id", true)).error?.code).toBe("42501");
  });
});

describe("audit log", () => {
  it("is readable by administrators only, holds no personal data, and cannot be edited", async () => {
    const audit = await users.admin1.client.from("audit_log").select("*");
    expect(audit.error).toBeNull();
    expect(audit.data!.length).toBeGreaterThan(0);
    expect(leaks(audit.data)).toBe(false);
    for (const who of ["parentA", "judge1", "stranger"] as const) expect((await users[who].client.from("audit_log").select("*")).data, who).toEqual([]);
    expect((await users.admin1.client.from("audit_log").update({ action: "x" }).eq("table_name", "scores")).error?.code).toBe("42501");
    expect((await users.admin1.client.from("audit_log").delete().eq("table_name", "scores")).error?.code).toBe("42501");
  });
});
