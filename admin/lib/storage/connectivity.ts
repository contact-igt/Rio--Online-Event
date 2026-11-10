import { GetBucketCorsCommand, GetBucketLifecycleConfigurationCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";

// Read-only checks of the R2 bucket. Exactly three request types exist here, and none can change anything:
//   ListObjectsV2 (MaxKeys 1)            the connection check: reachable? credentials accepted? bucket readable?
//   GetBucketCors                        read the CORS rules
//   GetBucketLifecycleConfiguration      read the lifecycle rules
// Nothing reads an object, and nothing here returns a key, an object name, an account id, an endpoint, a credential or an
// error message: only fixed categories and booleans. A failure is reported once and never retried (the caller builds the
// client with maxAttempts 1, and every call has a timeout).

export type Verdict = "PASS" | "FAIL" | "UNKNOWN";
export type ErrorCategory = "timeout" | "network" | "dns" | "tls" | "invalid-access-key" | "bad-signature" | "access-denied" | "no-such-bucket" | "rate-limited" | "server-error" | "unknown";

export type ConnectionCheck = { connectivity: Verdict; authentication: Verdict; bucketAccess: Verdict; objectCount: 0 | 1 | null; category: ErrorCategory | null };

type Err = { name?: string; code?: string; $metadata?: { httpStatusCode?: number }; $response?: unknown };

/** Maps an SDK or network error to a fixed category. Looks only at error names, codes and status numbers, never at messages. */
export function classifyR2Error(e: unknown): { category: ErrorCategory; reachedServer: boolean } {
  const x = (e ?? {}) as Err;
  const name = x.name ?? "";
  const code = x.code ?? "";
  const status = x.$metadata?.httpStatusCode ?? 0;
  if (name === "AbortError" || name === "TimeoutError" || code === "ETIMEDOUT" || name === "RequestTimeout") return { category: "timeout", reachedServer: false };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { category: "dns", reachedServer: false };
  if (/^(CERT_|ERR_TLS|DEPTH_ZERO|UNABLE_TO_VERIFY|SELF_SIGNED)/.test(code) || code === "EPROTO") return { category: "tls", reachedServer: false };
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EPIPE") return { category: "network", reachedServer: false };
  if (name === "InvalidAccessKeyId" || name === "InvalidAccessKey") return { category: "invalid-access-key", reachedServer: true };
  if (name === "SignatureDoesNotMatch") return { category: "bad-signature", reachedServer: true };
  if (name === "NoSuchBucket" || (status === 404 && name !== "NoSuchCORSConfiguration" && name !== "NoSuchLifecycleConfiguration")) return { category: "no-such-bucket", reachedServer: true };
  if (name === "AccessDenied" || name === "Forbidden" || status === 403 || status === 401) return { category: "access-denied", reachedServer: true };
  if (status === 429 || name === "SlowDown" || name === "TooManyRequests") return { category: "rate-limited", reachedServer: true };
  if (status >= 500) return { category: "server-error", reachedServer: true };
  return { category: "unknown", reachedServer: status > 0 };
}

/** Exactly one ListObjectsV2 request with MaxKeys=1. Returns only verdicts and how many objects came back (0 or 1). */
export async function checkBucketConnection(client: Pick<S3Client, "send">, bucket: string, timeoutMs = 15_000): Promise<ConnectionCheck> {
  try {
    const out = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }), { abortSignal: AbortSignal.timeout(timeoutMs) });
    return { connectivity: "PASS", authentication: "PASS", bucketAccess: "PASS", objectCount: (out.KeyCount ?? out.Contents?.length ?? 0) > 0 ? 1 : 0, category: null };
  } catch (e) {
    const { category, reachedServer } = classifyR2Error(e);
    if (!reachedServer) return { connectivity: "FAIL", authentication: "UNKNOWN", bucketAccess: "UNKNOWN", objectCount: null, category };
    const authFailed = category === "invalid-access-key" || category === "bad-signature";
    return {
      connectivity: "PASS",
      authentication: authFailed ? "FAIL" : category === "access-denied" || category === "no-such-bucket" ? "PASS" : "UNKNOWN",
      bucketAccess: authFailed ? "UNKNOWN" : "FAIL",
      objectCount: null,
      category,
    };
  }
}

// ---- configuration review ------------------------------------------------------------------------------------------

export type ConfigStatus = "CONFIGURED" | "NOT CONFIGURED" | "MISMATCH" | "UNVERIFIED";
export type CorsReview = { status: ConfigStatus; originLocalhost3100: boolean; noWildcardOrigin: boolean; methodPut: boolean; headerContentType: boolean; exposesEtag: boolean };
export type LifecycleReview = { status: ConfigStatus; pendingPrefixExpiresInOneDay: boolean };

type CorsRule = { AllowedOrigins?: string[]; AllowedMethods?: string[]; AllowedHeaders?: string[]; ExposeHeaders?: string[] };
type LifecycleRule = { Status?: string; Filter?: { Prefix?: string }; Prefix?: string; Expiration?: { Days?: number } };

const lower = (a: string[] | undefined) => (a ?? []).map((x) => x.toLowerCase());

/** Pure: judges CORS rules against what the browser upload needs. Returns booleans only. */
export function reviewCors(rules: CorsRule[]): CorsReview {
  const origins = rules.flatMap((r) => r.AllowedOrigins ?? []);
  const originLocalhost3100 = origins.includes("http://localhost:3100");
  const noWildcardOrigin = !origins.includes("*");
  const methodPut = rules.some((r) => lower(r.AllowedMethods).includes("put"));
  const headerContentType = rules.some((r) => lower(r.AllowedHeaders).some((h) => h === "content-type" || h === "*"));
  const exposesEtag = rules.some((r) => lower(r.ExposeHeaders).includes("etag"));
  const all = originLocalhost3100 && noWildcardOrigin && methodPut && headerContentType && exposesEtag;
  return { status: rules.length === 0 ? "NOT CONFIGURED" : all ? "CONFIGURED" : "MISMATCH", originLocalhost3100, noWildcardOrigin, methodPut, headerContentType, exposesEtag };
}

/** Pure: is there an enabled rule that deletes the pending/ prefix after one day? */
export function reviewLifecycle(rules: LifecycleRule[]): LifecycleReview {
  const ok = rules.some((r) => r.Status === "Enabled" && (r.Filter?.Prefix ?? r.Prefix) === "pending/" && r.Expiration?.Days === 1);
  return { status: rules.length === 0 ? "NOT CONFIGURED" : ok ? "CONFIGURED" : "MISMATCH", pendingPrefixExpiresInOneDay: ok };
}

const unverified = (cors: boolean): CorsReview | LifecycleReview =>
  cors
    ? { status: "UNVERIFIED", originLocalhost3100: false, noWildcardOrigin: false, methodPut: false, headerContentType: false, exposesEtag: false }
    : { status: "UNVERIFIED", pendingPrefixExpiresInOneDay: false };

/** One GetBucketCors request. An absent configuration is "NOT CONFIGURED"; a token that may not read it is "UNVERIFIED". */
export async function readCorsReview(client: Pick<S3Client, "send">, bucket: string, timeoutMs = 15_000): Promise<CorsReview> {
  try {
    const out = await client.send(new GetBucketCorsCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(timeoutMs) });
    return reviewCors(out.CORSRules ?? []);
  } catch (e) {
    if ((e as Err).name === "NoSuchCORSConfiguration") return reviewCors([]);
    return unverified(true) as CorsReview;
  }
}

/** One GetBucketLifecycleConfiguration request, with the same three outcomes. */
export async function readLifecycleReview(client: Pick<S3Client, "send">, bucket: string, timeoutMs = 15_000): Promise<LifecycleReview> {
  try {
    const out = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(timeoutMs) });
    return reviewLifecycle(out.Rules ?? []);
  } catch (e) {
    if ((e as Err).name === "NoSuchLifecycleConfiguration") return reviewLifecycle([]);
    return unverified(false) as LifecycleReview;
  }
}
