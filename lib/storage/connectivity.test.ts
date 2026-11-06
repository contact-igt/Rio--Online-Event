import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkBucketConnection, classifyR2Error, readCorsReview, readLifecycleReview, reviewCors, reviewLifecycle } from "./connectivity";

// All offline: the client is a stub that records the commands it is given. They prove WHAT would be sent (read-only,
// at most one request each) and WHAT would be printed (verdicts only).

type Sent = { constructor: { name: string }; input: Record<string, unknown> };
const fake = (impl: (cmd: Sent) => unknown) => {
  const send = vi.fn(async (...args: unknown[]) => impl(args[0] as Sent));
  return { client: { send } as never, send };
};
const httpError = (name: string, status: number, code?: string) => Object.assign(new Error("MESSAGE-WITH-SECRET-ACCOUNT-ID-abc123"), { name, code, $metadata: { httpStatusCode: status } });
const throwing = (error: unknown) =>
  fake(() => {
    throw error;
  });

describe("checkBucketConnection sends exactly one read-only request", () => {
  it("one ListObjectsV2 with MaxKeys=1 and nothing else", async () => {
    const { client, send } = fake(() => ({ KeyCount: 0, Contents: [] }));
    await checkBucketConnection(client, "dev-bucket");
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]![0] as unknown as Sent;
    expect(cmd.constructor.name).toBe("ListObjectsV2Command");
    expect(cmd.input).toEqual({ Bucket: "dev-bucket", MaxKeys: 1 });
    expect(Object.keys(cmd.input)).not.toContain("Prefix"); // not even a name filter
  });

  it("an empty bucket and a bucket with an object both PASS, reporting only 0 or 1, never the object", async () => {
    const empty = await checkBucketConnection(fake(() => ({ KeyCount: 0 })).client, "b");
    expect(empty).toEqual({ connectivity: "PASS", authentication: "PASS", bucketAccess: "PASS", objectCount: 0, category: null });
    const one = await checkBucketConnection(fake(() => ({ KeyCount: 1, Contents: [{ Key: "videos/secret-object-name", Size: 123, ETag: '"e"' }] })).client, "b");
    expect(one).toEqual({ connectivity: "PASS", authentication: "PASS", bucketAccess: "PASS", objectCount: 1, category: null });
    expect(JSON.stringify(one)).not.toMatch(/secret-object-name|videos|123|ETag/);
  });

  it("never retries: a failing request is sent once", async () => {
    const { client, send } = throwing(httpError("InternalError", 500));
    const r = await checkBucketConnection(client, "b");
    expect(send).toHaveBeenCalledTimes(1);
    expect(r.category).toBe("server-error");
  });

  it("gives every request a timeout", async () => {
    const { client, send } = fake(() => ({ KeyCount: 0 }));
    await checkBucketConnection(client, "b", 5000);
    const options = (send.mock.calls[0] as unknown[])[1] as { abortSignal: AbortSignal };
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("separates connectivity, authentication and bucket access failures, and never echoes a message", async () => {
    const cases: [unknown, Record<string, unknown>][] = [
      [Object.assign(new Error("getaddrinfo ENOTFOUND acct.r2.cloudflarestorage.com"), { code: "ENOTFOUND" }), { connectivity: "FAIL", authentication: "UNKNOWN", bucketAccess: "UNKNOWN", category: "dns" }],
      [Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }), { connectivity: "FAIL", category: "network" }],
      [Object.assign(new Error("aborted"), { name: "TimeoutError" }), { connectivity: "FAIL", category: "timeout" }],
      [httpError("InvalidAccessKeyId", 403), { connectivity: "PASS", authentication: "FAIL", bucketAccess: "UNKNOWN", category: "invalid-access-key" }],
      [httpError("SignatureDoesNotMatch", 403), { connectivity: "PASS", authentication: "FAIL", bucketAccess: "UNKNOWN", category: "bad-signature" }],
      [httpError("AccessDenied", 403), { connectivity: "PASS", authentication: "PASS", bucketAccess: "FAIL", category: "access-denied" }],
      [httpError("NoSuchBucket", 404), { connectivity: "PASS", authentication: "PASS", bucketAccess: "FAIL", category: "no-such-bucket" }],
      [httpError("SlowDown", 429), { connectivity: "PASS", bucketAccess: "FAIL", category: "rate-limited" }],
    ];
    for (const [error, expected] of cases) {
      const r = await checkBucketConnection(throwing(error).client, "b");
      expect(r).toMatchObject(expected);
      expect(r.objectCount).toBeNull();
      expect(JSON.stringify(r)).not.toMatch(/SECRET|abc123|cloudflarestorage|getaddrinfo/);
    }
  });
});

describe("classifyR2Error", () => {
  it("falls back to 'unknown' for anything it does not recognise, and handles odd input", () => {
    expect(classifyR2Error(new Error("something"))).toEqual({ category: "unknown", reachedServer: false });
    expect(classifyR2Error(undefined).category).toBe("unknown");
    expect(classifyR2Error("string error").category).toBe("unknown");
    expect(classifyR2Error({ $metadata: { httpStatusCode: 418 } })).toEqual({ category: "unknown", reachedServer: true });
  });
});

describe("configuration review (read-only)", () => {
  const rule = { AllowedOrigins: ["http://localhost:3100"], AllowedMethods: ["PUT"], AllowedHeaders: ["Content-Type"], ExposeHeaders: ["ETag"] };

  it("CORS: CONFIGURED only with the exact origin, PUT, Content-Type and ETag, and no wildcard origin", () => {
    expect(reviewCors([rule])).toEqual({ status: "CONFIGURED", originLocalhost3100: true, noWildcardOrigin: true, methodPut: true, headerContentType: true, exposesEtag: true });
    expect(reviewCors([]).status).toBe("NOT CONFIGURED");
    expect(reviewCors([{ ...rule, AllowedOrigins: ["*"] }])).toMatchObject({ status: "MISMATCH", originLocalhost3100: false, noWildcardOrigin: false });
    expect(reviewCors([{ ...rule, AllowedOrigins: ["http://localhost:3100", "*"] }])).toMatchObject({ status: "MISMATCH", noWildcardOrigin: false });
    expect(reviewCors([{ ...rule, AllowedMethods: ["GET"] }])).toMatchObject({ status: "MISMATCH", methodPut: false });
    expect(reviewCors([{ ...rule, ExposeHeaders: [] }])).toMatchObject({ status: "MISMATCH", exposesEtag: false });
    expect(reviewCors([{ ...rule, AllowedHeaders: [] }])).toMatchObject({ status: "MISMATCH", headerContentType: false });
    expect(reviewCors([{ ...rule, AllowedMethods: ["put"], AllowedHeaders: ["content-type"], ExposeHeaders: ["etag"] }]).status).toBe("CONFIGURED"); // case-insensitive
  });

  it("lifecycle: CONFIGURED only for an enabled rule that expires the pending/ prefix after exactly 1 day", () => {
    const good = { Status: "Enabled", Filter: { Prefix: "pending/" }, Expiration: { Days: 1 } };
    expect(reviewLifecycle([good])).toEqual({ status: "CONFIGURED", pendingPrefixExpiresInOneDay: true });
    expect(reviewLifecycle([]).status).toBe("NOT CONFIGURED");
    expect(reviewLifecycle([{ ...good, Status: "Disabled" }]).status).toBe("MISMATCH");
    expect(reviewLifecycle([{ ...good, Expiration: { Days: 7 } }]).status).toBe("MISMATCH");
    expect(reviewLifecycle([{ ...good, Filter: { Prefix: "videos/" } }]).status).toBe("MISMATCH"); // must never expire verified videos
    expect(reviewLifecycle([{ Status: "Enabled", Prefix: "pending/", Expiration: { Days: 1 } }]).status).toBe("CONFIGURED");
  });

  it("each review is one read-only request; a missing configuration is NOT CONFIGURED and a refused read is UNVERIFIED", async () => {
    const a = fake(() => ({ CORSRules: [rule] }));
    expect((await readCorsReview(a.client, "b")).status).toBe("CONFIGURED");
    expect(a.send).toHaveBeenCalledTimes(1);
    expect((a.send.mock.calls[0]![0] as unknown as Sent).constructor.name).toBe("GetBucketCorsCommand");
    expect((await readCorsReview(throwing(httpError("NoSuchCORSConfiguration", 404)).client, "b")).status).toBe("NOT CONFIGURED");
    expect((await readCorsReview(throwing(httpError("AccessDenied", 403)).client, "b")).status).toBe("UNVERIFIED");

    const l = fake(() => ({ Rules: [{ Status: "Enabled", Filter: { Prefix: "pending/" }, Expiration: { Days: 1 } }] }));
    expect((await readLifecycleReview(l.client, "b")).status).toBe("CONFIGURED");
    expect(l.send).toHaveBeenCalledTimes(1);
    expect((l.send.mock.calls[0]![0] as unknown as Sent).constructor.name).toBe("GetBucketLifecycleConfigurationCommand");
    expect((await readLifecycleReview(throwing(httpError("NoSuchLifecycleConfiguration", 404)).client, "b")).status).toBe("NOT CONFIGURED");
    expect((await readLifecycleReview(throwing(httpError("AccessDenied", 403)).client, "b")).status).toBe("UNVERIFIED");
  });
});

describe("the check can only read", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("the connectivity module imports only the three read-only commands, and no write or object-read command", () => {
    const src = read("lib/storage/connectivity.ts");
    const imported = src.match(/import \{([^}]+)\} from "@aws-sdk\/client-s3"/)![1]!.split(",").map((x) => x.trim().replace(/^type\s+/, ""));
    expect(imported.sort()).toEqual(["GetBucketCorsCommand", "GetBucketLifecycleConfigurationCommand", "ListObjectsV2Command", "S3Client"].sort());
    expect(src).not.toMatch(/PutObject|GetObject|CopyObject|DeleteObject|PutBucket|DeleteBucket|CreateMultipart|getSignedUrl/);
  });

  it("the script sends nothing without the explicit confirmation, never retries, and prints nothing from the configuration", () => {
    const script = read("scripts/check-r2-connection.ts");
    expect(script).toContain(`RIO_CONFIRM_R2_CHECK !== "yes"`);
    expect(script.indexOf("RIO_CONFIRM_R2_CHECK")).toBeLessThan(script.indexOf("createR2Client("));
    expect(script).toContain("maxAttempts: 1");
    for (const line of script.split("\n").filter((l) => /console\.(log|error)/.test(l))) expect(line, line).not.toMatch(/\$\{cfg\./);
  });
});
