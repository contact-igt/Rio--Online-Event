import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFinalizeDb, createFinalizeDeps, finalizeAvailable, finalizeConfigured, finalizeEnabled, submitStep } from "./server";

// Final submission is offered and served only when ITS OWN switch is exactly "yes" AND everything it needs is present.
// It is independent of the upload switch: uploads being on does not turn it on, and the reverse.

const r2 = { R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", R2_BUCKET_NAME: "rio-test-videos", R2_ACCESS_KEY_ID: "a".repeat(32), R2_SECRET_ACCESS_KEY: "b".repeat(64) };
const configured = { ...r2, SUPABASE_SECRET_KEY: "sb_secret_x" };
const on = { ...configured, RIO_FINALIZE_ENABLED: "yes" };

describe("finalizeEnabled (the switch)", () => {
  it("only the exact value yes turns it on", () => {
    expect(finalizeEnabled({ RIO_FINALIZE_ENABLED: "yes" })).toBe(true);
  });

  it("missing, empty, no and every other spelling mean off", () => {
    for (const value of [undefined, "", " ", "no", "No", "NO", "YES", "Yes", " yes", "yes ", "yes\n", "true", "1", "on", "enabled", "y", "yess", "0", "false"]) {
      expect(finalizeEnabled({ RIO_FINALIZE_ENABLED: value }), JSON.stringify(value)).toBe(false);
    }
    expect(finalizeEnabled({})).toBe(false);
  });

  it("is independent of the upload switch", () => {
    expect(finalizeEnabled({ RIO_UPLOADS_ENABLED: "yes" })).toBe(false);
    expect(finalizeEnabled({ RIO_UPLOADS_ENABLED: "no", RIO_FINALIZE_ENABLED: "yes" })).toBe(true);
  });
});

describe("finalizeAvailable needs the switch AND the configuration", () => {
  it("flag missing or no: off, even when fully configured", () => {
    expect(finalizeAvailable(configured)).toBe(false);
    expect(finalizeAvailable({ ...configured, RIO_FINALIZE_ENABLED: "no" })).toBe(false);
  });
  it("flag yes with everything configured: on", () => {
    expect(finalizeAvailable(on)).toBe(true);
  });
  it("flag yes but something missing: still off", () => {
    expect(finalizeAvailable({ RIO_FINALIZE_ENABLED: "yes" })).toBe(false);
    expect(finalizeAvailable({ ...r2, RIO_FINALIZE_ENABLED: "yes" })).toBe(false);
    expect(finalizeAvailable({ ...on, SUPABASE_SECRET_KEY: "" })).toBe(false);
    expect(finalizeAvailable({ ...on, R2_BUCKET_NAME: "" })).toBe(false);
    expect(finalizeConfigured(configured)).toBe(true);
  });
});

describe("submitStep: what the registration page shows", () => {
  const event = { slug: "kutti-pesalar", nameTa: "குட்டிப் பேச்சாளர்", nameEn: "Little Speaker" };
  const uploaded = { id: "bbbbbbbb-0000-4000-8000-0000000000b1", status: "uploaded", childName: "Asha", childAge: 9, mediaConsent: false };

  it("registration open but the flag OFF (missing or no): the submit step is disabled", () => {
    expect(submitStep({ open: true, current: uploaded, event }, configured)).toEqual({ kind: "off" });
    expect(submitStep({ open: true, current: uploaded, event }, { ...configured, RIO_FINALIZE_ENABLED: "no" })).toEqual({ kind: "off" });
    expect(submitStep({ open: true, current: uploaded, event }, {})).toEqual({ kind: "off" });
  });

  it("flag on, registration open and an UPLOADED entry: the working step, with the details to confirm", () => {
    expect(submitStep({ open: true, current: uploaded, event }, on)).toEqual({
      kind: "on", submissionId: uploaded.id, slug: "kutti-pesalar", childName: "Asha", childAge: 9, eventNameTa: event.nameTa, eventNameEn: "Little Speaker", mediaConsent: false,
    });
  });

  it("flag on but not eligible: a draft (no video yet), a submitted or withdrawn entry, no entry, or registration closed", () => {
    for (const status of ["draft", "finalized", "withdrawn", "weird"]) expect(submitStep({ open: true, current: { ...uploaded, status }, event }, on), status).toEqual({ kind: "off" });
    expect(submitStep({ open: true, current: null, event }, on)).toEqual({ kind: "off" });
    expect(submitStep({ open: false, current: uploaded, event }, on)).toEqual({ kind: "off" });
  });

  it("flag on but not configured: disabled", () => {
    expect(submitStep({ open: true, current: uploaded, event }, { RIO_FINALIZE_ENABLED: "yes" })).toEqual({ kind: "off" });
  });
});

describe("createFinalizeDeps (the last line of defence)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses to build anything while the switch is off, however complete the configuration is", () => {
    for (const value of ["no", "", "YES", "true"]) {
      vi.unstubAllEnvs();
      for (const [name, v] of Object.entries(configured)) vi.stubEnv(name, v);
      vi.stubEnv("RIO_FINALIZE_ENABLED", value);
      expect(() => createFinalizeDeps(), value).toThrow("switched off");
    }
  });
});

describe("createFinalizeDb", () => {
  const rpc = vi.fn();
  const db = createFinalizeDb({ rpc } as unknown as SupabaseClient);

  it("calls only the two service-role functions, with the owner passed explicitly", async () => {
    rpc.mockResolvedValueOnce({ data: [{ upload_id: "u1", bytes: "20971520", content_type: "video/mp4", etag: '"e"', event_id: 4, consent_version: "v0-provisional", already: false }], error: null });
    expect(await db.check("owner", "sub")).toEqual({ uploadId: "u1", bytes: 20971520, type: "video/mp4", etag: '"e"', eventId: 4, consentVersion: "v0-provisional", already: false });
    expect(rpc).toHaveBeenLastCalledWith("check_finalize", { p_owner: "owner", p_submission: "sub" });
    rpc.mockResolvedValueOnce({ data: "finalized", error: null });
    expect(await db.finalize("owner", "sub", "u1", 5, "video/mp4", '"e"')).toBe("finalized");
    expect(rpc).toHaveBeenLastCalledWith("finalize_verified_submission", { p_owner: "owner", p_submission: "sub", p_upload: "u1", p_bytes: 5, p_content_type: "video/mp4", p_etag: '"e"' });
    rpc.mockResolvedValueOnce({ data: "already_finalized", error: null });
    expect(await db.finalize("owner", "sub", "u1", 5, "video/mp4", '"e"')).toBe("already_finalized");
  });

  it("turns a database error into an Error carrying only the database's message, and an empty answer into 'video_not_verified'", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "submissions_closed" } });
    await expect(db.check("o", "s")).rejects.toThrow("submissions_closed");
    rpc.mockResolvedValueOnce({ data: null, error: { message: "duplicate_entry" } });
    await expect(db.finalize("o", "s", "u", 1, "t", "e")).rejects.toThrow("duplicate_entry");
    rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(db.check("o", "s")).rejects.toThrow("video_not_verified");
  });
});
