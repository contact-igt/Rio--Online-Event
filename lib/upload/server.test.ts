import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createUploadDb, createUploadDeps, uploadStep, uploadsAvailable, uploadsConfigured, uploadsEnabled } from "./server";

// The upload path is offered and served only when the master switch is exactly "yes" AND everything it needs is present.

const r2 = { R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", R2_BUCKET_NAME: "rio-test-videos", R2_ACCESS_KEY_ID: "a".repeat(32), R2_SECRET_ACCESS_KEY: "b".repeat(64) };
const configured = { ...r2, SUPABASE_SECRET_KEY: "sb_secret_x" };
const on = { ...configured, RIO_UPLOADS_ENABLED: "yes" };

describe("uploadsEnabled (the switch)", () => {
  it("only the exact value yes turns uploads on", () => {
    expect(uploadsEnabled({ RIO_UPLOADS_ENABLED: "yes" })).toBe(true);
  });

  it("missing, empty, no and every other spelling mean off", () => {
    for (const value of [undefined, "", " ", "no", "No", "NO", "YES", "Yes", " yes", "yes ", "yes\n", "true", "1", "on", "enabled", "y", "yess", "0", "false"]) {
      expect(uploadsEnabled({ RIO_UPLOADS_ENABLED: value }), JSON.stringify(value)).toBe(false);
    }
    expect(uploadsEnabled({})).toBe(false);
  });
});

describe("uploadsConfigured", () => {
  it("is false until the four R2 settings AND the secret key are all present", () => {
    expect(uploadsConfigured({})).toBe(false);
    expect(uploadsConfigured(r2)).toBe(false); // R2 alone is not enough: the upload functions need the secret key
    expect(uploadsConfigured({ SUPABASE_SECRET_KEY: "sb_secret_x" })).toBe(false);
    expect(uploadsConfigured(configured)).toBe(true);
    expect(uploadsConfigured({ ...r2, SUPABASE_SECRET_KEY: "   " })).toBe(false);
    for (const name of Object.keys(r2)) expect(uploadsConfigured({ ...configured, [name]: "" }), name).toBe(false);
  });

  it("is false when a secret-looking name would reach the browser", () => {
    expect(uploadsConfigured({ ...configured, NEXT_PUBLIC_R2_SECRET_ACCESS_KEY: "leak" })).toBe(false);
  });
});

describe("uploadsAvailable needs the switch AND the configuration", () => {
  it("flag missing: off, even when fully configured", () => {
    expect(uploadsAvailable(configured)).toBe(false);
  });
  it("flag set to no: off", () => {
    expect(uploadsAvailable({ ...configured, RIO_UPLOADS_ENABLED: "no" })).toBe(false);
  });
  it("flag set to yes with everything configured: on", () => {
    expect(uploadsAvailable(on)).toBe(true);
  });
  it("flag set to yes but something missing: still off", () => {
    expect(uploadsAvailable({ RIO_UPLOADS_ENABLED: "yes" })).toBe(false);
    expect(uploadsAvailable({ ...r2, RIO_UPLOADS_ENABLED: "yes" })).toBe(false);
    expect(uploadsAvailable({ ...on, SUPABASE_SECRET_KEY: "" })).toBe(false);
    expect(uploadsAvailable({ ...on, R2_BUCKET_NAME: "" })).toBe(false);
  });
});

describe("uploadStep: what the registration page shows", () => {
  const draft = { id: "bbbbbbbb-0000-4000-8000-0000000000b1", status: "draft" };

  it("registration open but the flag OFF (missing or no): the upload step is disabled", () => {
    expect(uploadStep({ open: true, current: draft }, configured)).toEqual({ kind: "off" });
    expect(uploadStep({ open: true, current: draft }, { ...configured, RIO_UPLOADS_ENABLED: "no" })).toEqual({ kind: "off" });
    expect(uploadStep({ open: true, current: draft }, {})).toEqual({ kind: "off" });
  });

  it("flag on and registration open: an eligible entry gets the working panel", () => {
    expect(uploadStep({ open: true, current: draft }, on)).toEqual({ kind: "on", submissionId: draft.id, hasVideo: false });
    expect(uploadStep({ open: true, current: { ...draft, status: "uploaded" } }, on)).toEqual({ kind: "on", submissionId: draft.id, hasVideo: true });
  });

  it("flag on but not eligible: registration closed, no entry chosen, or the entry is finalized or withdrawn", () => {
    expect(uploadStep({ open: false, current: draft }, on)).toEqual({ kind: "off" });
    expect(uploadStep({ open: true, current: null }, on)).toEqual({ kind: "off" });
    for (const status of ["finalized", "withdrawn", "weird"]) expect(uploadStep({ open: true, current: { ...draft, status } }, on), status).toEqual({ kind: "off" });
  });

  it("flag on but not configured: disabled", () => {
    expect(uploadStep({ open: true, current: draft }, { RIO_UPLOADS_ENABLED: "yes" })).toEqual({ kind: "off" });
  });
});

describe("createUploadDeps (the last line of defence)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses to build anything while the switch is off, however complete the configuration is", () => {
    for (const [name, value] of Object.entries(configured)) vi.stubEnv(name, value);
    vi.stubEnv("RIO_UPLOADS_ENABLED", "no");
    expect(() => createUploadDeps()).toThrow("switched off");
    vi.stubEnv("RIO_UPLOADS_ENABLED", "");
    expect(() => createUploadDeps()).toThrow("switched off");
    vi.unstubAllEnvs();
    for (const [name, value] of Object.entries(configured)) vi.stubEnv(name, value);
    vi.stubEnv("RIO_UPLOADS_ENABLED", "YES");
    expect(() => createUploadDeps()).toThrow("switched off");
  });
});

describe("createUploadDb", () => {
  const rpc = vi.fn();
  const db = createUploadDb({ rpc } as unknown as SupabaseClient);

  it("calls only the service-role functions, with the owner passed explicitly", async () => {
    rpc.mockResolvedValueOnce({ data: [{ upload_id: "u1", expires_at: "t" }], error: null });
    expect(await db.issue("owner", "sub", "video/mp4", 5)).toEqual({ uploadId: "u1", expiresAt: "t" });
    expect(rpc).toHaveBeenLastCalledWith("issue_video_upload", { p_owner: "owner", p_submission: "sub", p_content_type: "video/mp4", p_bytes: 5 });
    rpc.mockResolvedValueOnce({ data: [{ declared_bytes: "20971520", content_type: "video/mp4" }], error: null });
    expect(await db.check("owner", "u1")).toEqual({ bytes: 20971520, type: "video/mp4" });
    expect(rpc).toHaveBeenLastCalledWith("check_video_upload", { p_owner: "owner", p_upload: "u1" });
    rpc.mockResolvedValueOnce({ data: "old-id", error: null });
    expect(await db.attach("owner", "u1", 5, "video/mp4", "e")).toEqual({ replaced: "old-id" });
    expect(rpc).toHaveBeenLastCalledWith("attach_video_upload", { p_owner: "owner", p_upload: "u1", p_bytes: 5, p_content_type: "video/mp4", p_etag: "e" });
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await db.attach("owner", "u1", 5, "video/mp4", "e")).toEqual({ replaced: null });
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await db.reject("owner", "u1", "rejected");
    expect(rpc).toHaveBeenLastCalledWith("reject_video_upload", { p_owner: "owner", p_upload: "u1", p_status: "rejected" });
  });

  it("turns a database error into an Error carrying only the database's message, and an empty answer into 'unavailable'", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "submissions_closed" } });
    await expect(db.issue("o", "s", "video/mp4", 5)).rejects.toThrow("submissions_closed");
    rpc.mockResolvedValueOnce({ data: null, error: { message: "not_found" } });
    await expect(db.check("o", "u")).rejects.toThrow("not_found");
    rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(db.issue("o", "s", "video/mp4", 5)).rejects.toThrow("unavailable");
    rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(db.check("o", "u")).rejects.toThrow("unavailable");
  });
});
