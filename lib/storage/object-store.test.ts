import { S3Client } from "@aws-sdk/client-s3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createR2Client, createR2Store, pendingKey, r2EnvReport, readR2Config, videoKey } from "./object-store";

// Everything here is offline: the credentials are made up, and presigning is pure computation. R2 itself is
// UNVERIFIED until it is configured and authorized.

const cfg = { accountId: "0123456789abcdef0123456789abcdef", bucket: "rio-test-videos", accessKeyId: "test-access-key-id-not-real-0000", secretAccessKey: "test-secret-not-real-test-secret-not-real" };
const ID = "3f2b8c1e-9a4d-4e57-8a0b-5c6d7e8f9a0b";

function store() {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  const send = vi.fn();
  client.send = send as unknown as typeof client.send;
  return { s: createR2Store(cfg, client), send };
}

describe("readR2Config", () => {
  const env = { R2_ACCOUNT_ID: cfg.accountId, R2_BUCKET_NAME: cfg.bucket, R2_ACCESS_KEY_ID: cfg.accessKeyId, R2_SECRET_ACCESS_KEY: cfg.secretAccessKey };
  it("returns the settings only when all four are present and well formed", () => {
    expect(readR2Config(env)).toEqual(cfg);
    for (const key of Object.keys(env)) expect(readR2Config({ ...env, [key]: "" }), key).toBeNull();
    expect(readR2Config({ ...env, R2_ACCOUNT_ID: "not-a-hex-account-id" })).toBeNull();
    expect(readR2Config({ ...env, R2_BUCKET_NAME: "Bad Bucket!" })).toBeNull();
    expect(readR2Config({})).toBeNull();
  });
});

describe("r2EnvReport (names and statuses only, never values)", () => {
  const good = { R2_ACCOUNT_ID: cfg.accountId, R2_BUCKET_NAME: cfg.bucket, R2_ACCESS_KEY_ID: "a".repeat(32), R2_SECRET_ACCESS_KEY: "b".repeat(64) };

  it("is ok when all four server-only settings are present and well formed", () => {
    const r = r2EnvReport(good);
    expect(r.ok).toBe(true);
    expect(r.vars).toEqual({ R2_ACCOUNT_ID: "ok", R2_ACCESS_KEY_ID: "ok", R2_SECRET_ACCESS_KEY: "ok", R2_BUCKET_NAME: "ok" });
    expect(r.publicLeaks).toEqual([]);
  });

  it("tells missing from badly formed, one variable at a time", () => {
    expect(r2EnvReport({}).vars).toEqual({ R2_ACCOUNT_ID: "missing", R2_ACCESS_KEY_ID: "missing", R2_SECRET_ACCESS_KEY: "missing", R2_BUCKET_NAME: "missing" });
    expect(r2EnvReport({ ...good, R2_ACCOUNT_ID: "  " }).vars.R2_ACCOUNT_ID).toBe("missing");
    expect(r2EnvReport({ ...good, R2_ACCOUNT_ID: "https://abc.r2.cloudflarestorage.com" }).vars.R2_ACCOUNT_ID).toBe("badFormat");
    expect(r2EnvReport({ ...good, R2_BUCKET_NAME: "Has Spaces" }).vars.R2_BUCKET_NAME).toBe("badFormat");
    expect(r2EnvReport({ ...good, R2_ACCESS_KEY_ID: "short" }).vars.R2_ACCESS_KEY_ID).toBe("badFormat");
    expect(r2EnvReport({ ...good, R2_SECRET_ACCESS_KEY: "has a space in it and is long enough to pass" }).vars.R2_SECRET_ACCESS_KEY).toBe("badFormat");
    expect(r2EnvReport({ ...good, R2_SECRET_ACCESS_KEY: "b".repeat(64) + "\n" }).vars.R2_SECRET_ACCESS_KEY).toBe("ok"); // a trailing newline from a paste is trimmed
    for (const name of Object.keys(good)) expect(r2EnvReport({ ...good, [name]: undefined }).ok, name).toBe(false);
  });

  it("never contains a value: serialising the report reveals none of the settings", () => {
    const secret = "S3cretValue" + "z".repeat(40);
    const r = r2EnvReport({ ...good, R2_SECRET_ACCESS_KEY: secret, NEXT_PUBLIC_R2_SECRET_ACCESS_KEY: secret });
    const text = JSON.stringify(r);
    for (const value of [secret, cfg.accountId, cfg.bucket, "a".repeat(32), "b".repeat(64)]) expect(text.includes(value)).toBe(false);
  });

  it("refuses to be ready when a secret-looking name would reach the browser", () => {
    const r = r2EnvReport({ ...good, NEXT_PUBLIC_R2_ACCESS_KEY_ID: "x", NEXT_PUBLIC_SUPABASE_SECRET_KEY: "y", NEXT_PUBLIC_SUPABASE_URL: "https://ok.example" });
    expect(r.publicLeaks.sort()).toEqual(["NEXT_PUBLIC_R2_ACCESS_KEY_ID", "NEXT_PUBLIC_SUPABASE_SECRET_KEY"]);
    expect(r.ok).toBe(false);
    expect(readR2Config({ ...good, NEXT_PUBLIC_R2_ACCESS_KEY_ID: "x" })).toBeNull();
  });
});

describe("the S3 client for Cloudflare R2", () => {
  it("uses region auto, the account's R2 endpoint, path-style addressing and no default checksums", async () => {
    const client = createR2Client(cfg);
    expect(await client.config.region()).toBe("auto");
    const endpoint = await client.config.endpoint!();
    expect(endpoint.protocol).toBe("https:");
    expect(endpoint.hostname).toBe(`${cfg.accountId}.r2.cloudflarestorage.com`);
    expect(client.config.forcePathStyle).toBe(true);
    expect(await client.config.requestChecksumCalculation()).toBe("WHEN_REQUIRED");
    expect(await client.config.responseChecksumValidation()).toBe("WHEN_REQUIRED");
    const creds = await client.config.credentials();
    expect(creds.accessKeyId).toBe(cfg.accessKeyId);
  });

  it("makes no network call just by being created or by presigning", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { s } = store();
    await s.presignPut(pendingKey(ID), { contentType: "video/mp4", expiresInSeconds: 900 });
    createR2Client(cfg);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("repository hygiene for the R2 settings", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it(".gitignore keeps every real env file out of Git and tracks only .env.example", () => {
    const lines = read(".gitignore").split(/\r?\n/).map((l) => l.trim());
    expect(lines).toContain(".env");
    expect(lines).toContain(".env.*"); // covers .env.local and .env.live
    expect(lines).toContain("!.env.example");
  });

  it(".env.example names all four R2 settings with placeholders only, and none is browser-visible", () => {
    const example = read(".env.example");
    for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]) expect(example).toMatch(new RegExp(`^# ${name}=<[^>]+>$`, "m"));
    expect(example).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(R2|SECRET|ACCESS_KEY)/);
    expect(example).not.toMatch(/^# R2_BUCKET=/m); // the old name
    expect(example).not.toMatch(/[0-9a-f]{32}/i); // no real-looking id or key
  });
});

describe("object names", () => {
  it("are built only from an id: no child, parent or event detail can appear", () => {
    expect(pendingKey(ID)).toBe(`pending/${ID}`);
    expect(videoKey(ID)).toBe(`videos/${ID}`);
  });
});

describe("presignPut", () => {
  it("signs a 15-minute PUT for one object on the account host, bound to its Content-Type, without a checksum", async () => {
    const { s } = store();
    const url = new URL(await s.presignPut(pendingKey(ID), { contentType: "video/mp4", expiresInSeconds: 900 }));
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe(`${cfg.accountId}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe(`/${cfg.bucket}/pending/${ID}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toMatch(/content-type/);
    expect([...url.searchParams.keys()].filter((k) => /checksum/i.test(k))).toEqual([]);
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never carries the secret, and different objects get different signatures", async () => {
    const { s } = store();
    const a = await s.presignPut(pendingKey(ID), { contentType: "video/mp4", expiresInSeconds: 900 });
    const b = await s.presignPut(pendingKey("11111111-2222-4333-8444-555555555555"), { contentType: "video/mp4", expiresInSeconds: 900 });
    expect(a).not.toContain(cfg.secretAccessKey);
    expect(new URL(a).searchParams.get("X-Amz-Signature")).not.toBe(new URL(b).searchParams.get("X-Amz-Signature"));
  });

  it("a different Content-Type gives a different signature, so a PUT with another type is refused by the bucket", async () => {
    const { s } = store();
    const mp4 = new URL(await s.presignPut(pendingKey(ID), { contentType: "video/mp4", expiresInSeconds: 900 }));
    const webm = new URL(await s.presignPut(pendingKey(ID), { contentType: "video/webm", expiresInSeconds: 900 }));
    expect(mp4.searchParams.get("X-Amz-Signature")).not.toBe(webm.searchParams.get("X-Amz-Signature"));
  });
});

describe("head, copy and remove", () => {
  it("head reports size, type and ETag, and null for a missing object", async () => {
    const { s, send } = store();
    send.mockResolvedValueOnce({ ContentLength: 1234, ContentType: "video/mp4", ETag: '"abc"' });
    expect(await s.head(pendingKey(ID))).toEqual({ bytes: 1234, contentType: "video/mp4", etag: '"abc"' });
    expect(send.mock.calls[0]![0].input).toEqual({ Bucket: cfg.bucket, Key: `pending/${ID}` });
    send.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }));
    expect(await s.head(pendingKey(ID))).toBeNull();
    send.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "InternalError", $metadata: { httpStatusCode: 500 } }));
    await expect(s.head(pendingKey(ID))).rejects.toThrow();
  });

  it("copy is conditional on the ETag that was verified", async () => {
    const { s, send } = store();
    send.mockResolvedValueOnce({});
    await s.copy(pendingKey(ID), videoKey(ID), '"abc"');
    expect(send.mock.calls[0]![0].input).toEqual({ Bucket: cfg.bucket, Key: `videos/${ID}`, CopySource: `${cfg.bucket}/pending/${ID}`, CopySourceIfMatch: '"abc"' });
  });

  it("remove deletes one key", async () => {
    const { s, send } = store();
    send.mockResolvedValueOnce({});
    await s.remove(videoKey(ID));
    expect(send.mock.calls[0]![0].input).toEqual({ Bucket: cfg.bucket, Key: `videos/${ID}` });
  });
});
