import { describe, expect, it, vi } from "vitest";
import { inviteJudgeFlow, inviteReadiness, inviteSchema, staffInvitesEnabled, type InviteDeps } from "./invites";

const NOW = Date.parse("2026-11-07T10:00:00Z");
const fresh = { userId: "u1", createdAt: "2026-11-07T09:59:30Z", lastSignInAt: null };

function deps(over: Partial<InviteDeps> = {}): InviteDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    now: () => NOW,
    judgeEmails: async () => {
      calls.push("emails");
      return ["existing.judge@example.test"];
    },
    invite: async (e) => {
      calls.push(`invite:${e}`);
      return { user: fresh };
    },
    provision: async (id, name) => {
      calls.push(`provision:${id}:${name}`);
      return true;
    },
    remove: async (id) => {
      calls.push(`remove:${id}`);
      return true;
    },
    ...over,
  };
}

describe("the invitation switch", () => {
  it("is off unless the value is exactly yes", () => {
    for (const v of [undefined, "", "no", "YES", "true", "1", " yes"]) expect(staffInvitesEnabled({ RIO_STAFF_INVITES_ENABLED: v })).toBe(false);
    expect(staffInvitesEnabled({ RIO_STAFF_INVITES_ENABLED: "yes" })).toBe(true);
  });
  it("is ready only with the switch AND a well-formed secret key, and never returns the key", () => {
    expect(inviteReadiness({})).toEqual({ enabled: false, secretKey: "missing", ready: false });
    expect(inviteReadiness({ RIO_STAFF_INVITES_ENABLED: "yes" }).ready).toBe(false);
    expect(inviteReadiness({ SUPABASE_SECRET_KEY: "sb_secret_abcdefghijklmnop" }).ready).toBe(false); // key without the switch
    const ok = inviteReadiness({ RIO_STAFF_INVITES_ENABLED: "yes", SUPABASE_SECRET_KEY: "sb_secret_abcdefghijklmnop" });
    expect(ok).toEqual({ enabled: true, secretKey: "ok", ready: true });
    expect(JSON.stringify(ok)).not.toContain("sb_secret");
  });
});

describe("input", () => {
  it("normalises the e-mail and the name, and refuses anything else", () => {
    expect(inviteSchema.parse({ email: "  Judge.One@Example.TEST ", displayName: "  Judge   One " })).toEqual({ email: "judge.one@example.test", displayName: "Judge One" });
    for (const bad of [{ email: "nope", displayName: "x" }, { email: "a@b.co", displayName: "" }, { email: "a@b.co", displayName: " " }, { email: "a@b.co", displayName: "x".repeat(81) }, { email: 5, displayName: "x" }, {}]) {
      expect(inviteSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("an invalid request reaches no dependency at all", async () => {
    const d = deps();
    expect(await inviteJudgeFlow(d, { email: "nope", displayName: "x" })).toEqual({ ok: false, code: "invalid" });
    expect(d.calls).toEqual([]);
  });
});

describe("inviteJudgeFlow", () => {
  it("invites, then records the role, and succeeds", async () => {
    const d = deps();
    expect(await inviteJudgeFlow(d, { email: "New.Judge@example.test", displayName: "New Judge" })).toEqual({ ok: true });
    expect(d.calls).toEqual(["emails", "invite:new.judge@example.test", "provision:u1:New Judge"]);
  });

  it("an e-mail that is already a judge is refused before anything is sent", async () => {
    const d = deps();
    expect(await inviteJudgeFlow(d, { email: "EXISTING.judge@example.test", displayName: "Again" })).toEqual({ ok: false, code: "alreadyJudge" });
    expect(d.calls).toEqual(["emails"]);
  });

  it("an e-mail that already has an account (a parent, say) is never turned into a judge, and nothing is provisioned or removed", async () => {
    const d = deps({ invite: async () => ({ error: "exists" }) });
    expect(await inviteJudgeFlow(d, { email: "parent@example.test", displayName: "P" })).toEqual({ ok: false, code: "duplicate" });
    expect(d.calls).toEqual(["emails"]);
  });

  it("a rate limit and any other invitation failure create nothing", async () => {
    expect(await inviteJudgeFlow(deps({ invite: async () => ({ error: "rateLimited" }) }), { email: "a@b.co", displayName: "A" })).toEqual({ ok: false, code: "tooMany" });
    const d = deps({ invite: async () => ({ error: "failed" }) });
    expect(await inviteJudgeFlow(d, { email: "a@b.co", displayName: "A" })).toEqual({ ok: false, code: "inviteFailed" });
    expect(await inviteJudgeFlow(deps({ invite: async () => { throw new Error("network"); } }), { email: "a@b.co", displayName: "A" })).toEqual({ ok: false, code: "inviteFailed" });
    expect(d.calls.some((c) => c.startsWith("provision") || c.startsWith("remove"))).toBe(false);
  });

  it("if the role cannot be recorded, a user created seconds ago is deleted again and nothing is left behind", async () => {
    const d = deps({ provision: async () => false });
    expect(await inviteJudgeFlow(d, { email: "a@b.co", displayName: "A" })).toEqual({ ok: false, code: "provisionFailed" });
    expect(d.calls).toContain("remove:u1");
  });

  it("if the role cannot be recorded and the user cannot be deleted, the result says exactly that (partial)", async () => {
    const d = deps({ provision: async () => false, remove: async () => false });
    expect(await inviteJudgeFlow(d, { email: "a@b.co", displayName: "A" })).toEqual({ ok: false, code: "partial" });
  });

  it("never deletes an account that is old or has signed in: it only reports partial", async () => {
    for (const user of [{ ...fresh, createdAt: "2026-10-01T00:00:00Z" }, { ...fresh, lastSignInAt: "2026-11-07T09:00:00Z" }, { ...fresh, createdAt: "not a date" }, { ...fresh, createdAt: "2026-11-07T10:05:00Z" }]) {
      const remove = vi.fn(async () => true);
      const d = deps({ invite: async () => ({ user }), provision: async () => false, remove });
      expect(await inviteJudgeFlow(d, { email: "a@b.co", displayName: "A" })).toEqual({ ok: false, code: "partial" });
      expect(remove).not.toHaveBeenCalled();
    }
  });

  it("a thrown provisioning error is handled like a refusal", async () => {
    const d = deps({ provision: async () => { throw new Error("db down"); } });
    expect(await inviteJudgeFlow(d, { email: "a@b.co", displayName: "A" })).toEqual({ ok: false, code: "provisionFailed" });
  });

  it("the result never carries a password, token, link or user id", async () => {
    const ok = JSON.stringify(await inviteJudgeFlow(deps(), { email: "a@b.co", displayName: "A" }));
    expect(ok).toBe('{"ok":true}');
  });
});
