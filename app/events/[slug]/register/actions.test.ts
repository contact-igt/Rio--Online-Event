import { beforeEach, describe, expect, it, vi } from "vitest";
import { events, fitsAge } from "@/lib/events";

// The action runs against a fake Supabase client that records every write. These tests prove OUR behaviour
// (what is validated, what payload is sent, what is refused). That row level security actually enforces ownership
// is proven separately by the database tests and the approval-gated live tests.

type Row = { id: string; event_id: number; child_name: string; parent_mobile: string; status: string; child_age?: number; parent_name?: string };
type Write = { table: string; op: "insert" | "update"; payload: Record<string, unknown>; filters: [string, unknown][] };

const h = vi.hoisted(() => {
  class Redirect extends Error {
    constructor(public url: string) {
      super(`redirect:${url}`);
    }
  }
  return {
    Redirect,
    revalidatePath: vi.fn(),
    writes: [] as Write[],
    user: null as null | { id: string; email: string },
    settings: null as null | { submissions_open_at: string | null; submissions_close_at: string | null; current_consent_version: string | null },
    own: [] as Row[],
    insertResult: { data: { id: "11111111-1111-4111-8111-111111111111" }, error: null } as { data: { id: string } | null; error: { code?: string; message?: string } | null },
    updateResult: { data: [{ id: "x" }], error: null } as { data: { id: string }[] | null; error: { code?: string; message?: string } | null },
    config: { broken: false },
  };
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new h.Redirect(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));

function table(name: string) {
  const s: { op: "select" | "insert" | "update"; payload: Record<string, unknown>; filters: [string, unknown][] } = { op: "select", payload: {}, filters: [] };
  const finish = (mode: "single" | "maybeSingle" | "list") => {
    if (s.op !== "select") h.writes.push({ table: name, op: s.op, payload: s.payload, filters: s.filters });
    if (name === "event_settings") return { data: h.settings, error: null };
    if (name === "submissions" && s.op === "select") return { data: h.own, error: null };
    if (name === "submissions" && s.op === "insert") return mode === "single" ? h.insertResult : { data: [h.insertResult.data], error: h.insertResult.error };
    if (name === "submissions" && s.op === "update") return h.updateResult;
    return { data: null, error: { message: "unexpected" } };
  };
  const api = {
    select: () => api,
    order: () => api,
    insert: (p: Record<string, unknown>) => ((s.op = "insert"), (s.payload = p), api),
    update: (p: Record<string, unknown>) => ((s.op = "update"), (s.payload = p), api),
    eq: (c: string, v: unknown) => (s.filters.push([c, v]), api),
    single: async () => finish("single"),
    maybeSingle: async () => finish("maybeSingle"),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(finish("list")).then(res, rej),
  };
  return api;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (h.config.broken) throw new Error("not configured");
    return { auth: { getUser: async () => ({ data: { user: h.user }, error: null }) }, from: table };
  },
}));

type Actions = typeof import("./actions");
let actions: Actions;

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const openSettings = () => ({ submissions_open_at: iso(-3_600_000), submissions_close_at: iso(3_600_000), current_consent_version: "v0-provisional" });
const base = { event: "kutti-pesalar", childName: "Asha Kumar", childAge: "9", parentName: "Meena Kumar", mobile: "98765 43210", guardianConsent: "on", consentVersion: "v0-provisional" };
const form = (over: Record<string, string | undefined> = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== undefined) fd.set(k, v);
  return fd;
};
async function run<T>(fn: () => Promise<T>): Promise<{ state?: T; redirect?: string }> {
  try {
    return { state: await fn() };
  } catch (e) {
    if (e instanceof h.Redirect) return { redirect: e.url };
    throw e;
  }
}
const save = (over?: Record<string, string | undefined>) => run(() => actions.saveDraft(undefined, form(over)));
const own = (over: Partial<Row> = {}): Row => ({ id: "22222222-2222-4222-8222-222222222222", event_id: 4, child_name: "Someone Else", parent_mobile: "+919123456780", status: "draft", child_age: 9, parent_name: "P", ...over });

beforeEach(async () => {
  vi.resetModules(); // fresh rate limiter per test
  h.writes.length = 0;
  h.revalidatePath.mockClear();
  h.user = { id: "u1", email: "Parent@Example.com" };
  h.settings = openSettings();
  h.own = [];
  h.insertResult = { data: { id: "11111111-1111-4111-8111-111111111111" }, error: null };
  h.updateResult = { data: [{ id: "x" }], error: null };
  h.config.broken = false;
  actions = await import("./actions");
});

describe("saving a new draft", () => {
  it("writes exactly the registration fields, with the verified email from the session and no owner id", async () => {
    const { redirect } = await save();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ table: "submissions", op: "insert" });
    expect(h.writes[0]!.payload).toEqual({
      event_id: 4,
      child_name: "Asha Kumar",
      child_age: 9,
      parent_name: "Meena Kumar",
      parent_email: "parent@example.com",
      parent_mobile: "+919876543210",
      consent_version: "v0-provisional",
      media_consent: false,
    });
    expect(redirect).toBe("/events/kutti-pesalar/register?draft=11111111-1111-4111-8111-111111111111&saved=1");
  });

  it("records the optional media consent separately from the mandatory guardian consent", async () => {
    await save({ mediaConsent: "on" });
    expect(h.writes[0]!.payload.media_consent).toBe(true);
    h.writes.length = 0;
    await save({ mediaConsent: undefined });
    expect(h.writes[0]!.payload.media_consent).toBe(false);
  });

  it("ignores every client-supplied owner, email, status, video, consent timestamp or date of birth", async () => {
    await save({ owner_id: "evil", parent_email: "evil@example.com", status: "finalized", video_key: "v", consent_at: "2020-01-01", entry_code: "RIO-X", dob: "2016-01-01", finalized_at: "x" });
    const payload = h.writes[0]!.payload;
    expect(Object.keys(payload).sort()).toEqual(["child_age", "child_name", "consent_version", "event_id", "media_consent", "parent_email", "parent_mobile", "parent_name"]);
    expect(payload.parent_email).toBe("parent@example.com");
  });

  it("uses the consent version from the database, not from the client", async () => {
    await save();
    expect(h.writes[0]!.payload.consent_version).toBe("v0-provisional");
  });
});

describe("session, settings and consent", () => {
  it("sends an expired or missing session back to sign-in, keeping the competition, and writes nothing", async () => {
    h.user = null;
    expect((await save()).redirect).toBe("/signin?event=kutti-pesalar&expired=1");
    expect(h.writes).toHaveLength(0);
  });

  it("refuses while registration is closed (no window, outside the window, or unknown consent version)", async () => {
    for (const closed of [
      null,
      { submissions_open_at: null, submissions_close_at: null, current_consent_version: null },
      { submissions_open_at: iso(3_600_000), submissions_close_at: iso(7_200_000), current_consent_version: "v0-provisional" },
      { submissions_open_at: iso(-7_200_000), submissions_close_at: iso(-3_600_000), current_consent_version: "v0-provisional" },
      { ...openSettings(), current_consent_version: "v9-unknown" },
    ]) {
      h.settings = closed;
      const { state } = await save();
      expect(state?.error?.en).toMatch(/not open/i);
    }
    expect(h.writes).toHaveLength(0);
  });

  it("requires the guardian consent", async () => {
    const { state } = await save({ guardianConsent: undefined });
    expect(state?.fieldErrors?.guardianConsent?.en).toMatch(/Guardian consent is needed/);
    expect(h.writes).toHaveLength(0);
  });

  it("does not accept media consent as a substitute for guardian consent", async () => {
    const { state } = await save({ guardianConsent: undefined, mediaConsent: "on" });
    expect(state?.fieldErrors?.guardianConsent).toBeDefined();
    expect(h.writes).toHaveLength(0);
  });

  it("asks the parent to read the new wording when the consent version changed while the form was open", async () => {
    const { state } = await save({ consentVersion: "v-older" });
    expect(state?.error?.en).toMatch(/consent wording has changed/i);
    expect(state?.values?.guardianConsent).toBe("");
    expect(h.revalidatePath).toHaveBeenCalledWith("/events/kutti-pesalar/register");
    expect(h.writes).toHaveLength(0);
  });

  it("reports 'unavailable' when the project is not configured", async () => {
    h.config.broken = true;
    expect((await save()).state?.error?.en).toMatch(/unavailable/i);
  });
});

describe("validation and eligibility", () => {
  it("rejects an age outside the competition's band, naming the band, without writing", async () => {
    const { state } = await save({ childAge: "7" }); // kutti-pesalar is 8-12
    expect(state?.fieldErrors?.childAge?.en).toBe("Only ages 8–12 can enter this competition.");
    expect(h.writes).toHaveLength(0);
  });

  it("accepts exactly the eligible ages for every competition", async () => {
    for (const event of events) {
      for (let age = 3; age <= 12; age++) {
        h.writes.length = 0;
        vi.resetModules();
        actions = await import("./actions");
        const { redirect, state } = await save({ event: event.slug, childAge: String(age), childName: `Child ${event.number}${age}`.replace(/\d/g, "x") });
        expect(Boolean(redirect), `${event.slug} age ${age}`).toBe(fitsAge(event, age));
        expect(h.writes.length, `${event.slug} age ${age}`).toBe(fitsAge(event, age) ? 1 : 0);
        if (!fitsAge(event, age)) expect(state?.fieldErrors?.childAge).toBeDefined();
      }
    }
  });

  it("returns field errors, and the parent's own input for the form, for every invalid field at once", async () => {
    const { state } = await save({ childName: "R2D2", parentName: "", mobile: "12345", childAge: "x" });
    expect(Object.keys(state?.fieldErrors ?? {}).sort()).toEqual(["childAge", "childName", "mobile", "parentName"]);
    expect(state?.values?.childName).toBe("R2D2");
    expect(h.writes).toHaveLength(0);
  });

  it("rejects an unknown or hostile competition", async () => {
    for (const event of [undefined, "", "https://evil.example", "nope"]) {
      expect((await save({ event })).state?.error?.en, String(event)).toMatch(/could not be found/);
    }
    expect(h.writes).toHaveLength(0);
  });

  it("does not crash on odd checkbox or draft values", async () => {
    await expect(save({ guardianConsent: "yes", mediaConsent: "<script>" })).resolves.toBeDefined();
    await expect(save({ draftId: "' or 1=1 --" })).resolves.toBeDefined();
  });
});

describe("one registration per child per competition, one finalized entry per child", () => {
  it("lets a parent register several different children", async () => {
    h.own = [own({ child_name: "Bala Kumar", parent_mobile: "+919876543210" })];
    expect((await save()).redirect).toMatch(/saved=1$/);
    expect(h.writes).toHaveLength(1);
  });

  it("blocks the same child in the same competition and points to the existing draft", async () => {
    h.own = [own({ child_name: "ASHA  kumar.", parent_mobile: "+919876543210", id: "33333333-3333-4333-8333-333333333333" })];
    const { state } = await save();
    expect(state?.error?.en).toMatch(/already has a registration/);
    expect(state?.duplicateId).toBe("33333333-3333-4333-8333-333333333333");
    expect(h.writes).toHaveLength(0);
  });

  it("allows the same child to have a draft in another competition", async () => {
    h.own = [own({ child_name: "Asha Kumar", parent_mobile: "+919876543210", event_id: 2 })];
    expect((await save()).redirect).toMatch(/saved=1$/);
  });

  it("blocks a child who already has a finalized entry in another competition", async () => {
    h.own = [own({ child_name: "Asha Kumar", parent_mobile: "+919876543210", event_id: 2, status: "finalized" })];
    const { state } = await save();
    expect(state?.error?.en).toMatch(/one competition only/);
    expect(h.writes).toHaveLength(0);
  });

  it("ignores withdrawn registrations when checking duplicates and the limit", async () => {
    h.own = [own({ child_name: "Asha Kumar", parent_mobile: "+919876543210", status: "withdrawn" })];
    expect((await save()).redirect).toMatch(/saved=1$/);
  });

  it("limits the number of registrations per parent account", async () => {
    h.own = Array.from({ length: 10 }, (_, i) => own({ id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`, child_name: `Child${"x".repeat(i + 1)}`, event_id: 2 }));
    const { state } = await save();
    expect(state?.error?.en).toMatch(/maximum number/);
    expect(h.writes).toHaveLength(0);
  });
});

describe("editing and resuming the parent's own draft", () => {
  const id = "44444444-4444-4444-8444-444444444444";
  const mine = () => own({ id, event_id: 4, child_name: "Asha Kumar", parent_mobile: "+919876543210", status: "draft" });

  it("updates only the editable fields, filtered to that draft, without touching consent, email or status", async () => {
    h.own = [mine()];
    h.updateResult = { data: [{ id }], error: null };
    const { redirect } = await save({ draftId: id, childName: "Asha K", guardianConsent: undefined, mediaConsent: "on" });
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ table: "submissions", op: "update", filters: [["id", id]] });
    expect(Object.keys(h.writes[0]!.payload).sort()).toEqual(["child_age", "child_name", "media_consent", "parent_mobile", "parent_name"]);
    expect(h.writes[0]!.payload).toMatchObject({ child_name: "Asha K", media_consent: true });
    expect(redirect).toBe(`/events/kutti-pesalar/register?draft=${id}&saved=1`);
  });

  it("does not count the draft being edited as its own duplicate", async () => {
    h.own = [mine()];
    h.updateResult = { data: [{ id }], error: null };
    expect((await save({ draftId: id })).redirect).toMatch(/saved=1$/);
  });

  it("will not edit a registration that is not in the parent's own list (another parent's, or unknown)", async () => {
    h.own = [];
    const { state } = await save({ draftId: id });
    expect(state?.error?.en).toMatch(/could not be found/);
    expect(h.writes).toHaveLength(0);
  });

  it("will not edit a draft that belongs to a different competition's page", async () => {
    h.own = [{ ...mine(), event_id: 2 }];
    expect((await save({ draftId: id })).state?.error?.en).toMatch(/could not be found/);
    expect(h.writes).toHaveLength(0);
  });

  it("will not edit once the entry has moved past draft", async () => {
    h.own = [{ ...mine(), status: "uploaded" }];
    expect((await save({ draftId: id })).state?.error?.en).toMatch(/can no longer be edited/);
    expect(h.writes).toHaveLength(0);
  });

  it("treats a database update that matched no row (row level security) as not found", async () => {
    h.own = [mine()];
    h.updateResult = { data: [], error: null };
    expect((await save({ draftId: id })).state?.error?.en).toMatch(/could not be found/);
  });

  it("rejects a draft id that is not a UUID", async () => {
    expect((await save({ draftId: "not-a-uuid" })).state?.error?.en).toMatch(/could not be found/);
    expect(h.writes).toHaveLength(0);
  });

  it("still validates the age band when editing", async () => {
    h.own = [mine()];
    const { state } = await save({ draftId: id, childAge: "6" });
    expect(state?.fieldErrors?.childAge).toBeDefined();
    expect(h.writes).toHaveLength(0);
  });
});

describe("database failures", () => {
  it("shows a safe message for each cause and keeps the parent's input", async () => {
    const cases: [{ code?: string; message?: string }, RegExp][] = [
      [{ message: "submissions_closed" }, /not open/],
      [{ message: "consent_version_mismatch" }, /consent wording has changed/],
      [{ message: "age_not_eligible" }, /Only ages/],
      [{ code: "23505", message: "duplicate key value" }, /already has a registration/],
      [{ code: "42501", message: "new row violates row-level security policy" }, /cannot register a child/],
      [{ code: "XX000", message: "connection reset for parent@example.com" }, /was not saved/],
    ];
    for (const [error, expected] of cases) {
      h.insertResult = { data: null, error };
      const { state, redirect } = await save();
      expect(redirect).toBeUndefined();
      const text = [state?.error?.en, state?.fieldErrors?.childAge?.en].join(" ");
      expect(text, JSON.stringify(error)).toMatch(expected);
      expect(JSON.stringify(state)).not.toMatch(/parent@example\.com|row-level security|duplicate key/);
      expect(state?.values?.childName).toBe("Asha Kumar");
    }
  });
});

describe("abuse limits and privacy", () => {
  it("limits saves per parent account", async () => {
    let last;
    for (let i = 0; i < 21; i++) last = await save();
    expect(last?.state?.error?.en).toMatch(/Too many attempts/);
  });

  it("never logs personal data and never returns the email", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await save({ childName: "Zorathustra Quill" });
    h.insertResult = { data: null, error: { code: "XX000", message: "Zorathustra Quill parent@example.com" } };
    const failed = await save({ childName: "Zorathustra Quill", mobile: "9753186420" });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(failed.state)).not.toContain("parent@example.com");
    vi.restoreAllMocks();
  });
});
