// Guards and pure helpers for the approval-gated LIVE upload test (e2e-live/upload.liveupload.ts). Plain TypeScript with no
// path aliases so Playwright and Vitest both load it. Nothing here makes a network call or prints a value.
//
// What it protects:
//   * the test can only run against the one bucket a human named, and only a dev-looking bucket;
//   * cleanup can only delete the exact object keys built from upload ids the test itself created;
//   * anything else that appears in the bucket during the run is reported, never deleted.

export class UploadGuardError extends Error {
  override name = "UploadGuardError";
}

type Env = Record<string, string | undefined>;

const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^(pending|videos)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * The live upload test needs a second, typed confirmation naming the bucket (RIO_LIVE_R2_CONFIRM must equal R2_BUCKET_NAME),
 * and the bucket must look like a development bucket. The switch for uploads must NOT already be on in the test process:
 * it is turned on only for the web server the test starts. Error messages are fixed strings (they never echo a value).
 */
export function assertUploadTarget(env: Env): { bucket: string } {
  const bucket = (env.R2_BUCKET_NAME ?? "").trim();
  if (!BUCKET.test(bucket)) throw new UploadGuardError("R2_BUCKET_NAME is missing or malformed.");
  if (env.RIO_LIVE_R2_CONFIRM !== bucket) throw new UploadGuardError("Set RIO_LIVE_R2_CONFIRM to the dev bucket name to allow the live upload test.");
  if (/prod|live/i.test(bucket)) throw new UploadGuardError("The bucket name looks like production; refusing.");
  if (!/dev|test|staging|sandbox/i.test(bucket)) throw new UploadGuardError("The bucket name does not look like a development bucket; refusing.");
  if (env.RIO_UPLOADS_ENABLED === "yes") throw new UploadGuardError("RIO_UPLOADS_ENABLED must not be on in the test process; the test turns it on for its own server only.");
  for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "SUPABASE_SECRET_KEY", "RIO_LIVE_URL", "RIO_LIVE_SECRET_KEY"]) {
    if (!env[name]?.trim()) throw new UploadGuardError("A required setting is missing; run npm run r2:check and npm run db:dev:check.");
  }
  return { bucket };
}

export const isUploadId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** The two object keys an upload id can ever have. */
export const keysFor = (id: string): [string, string] => [`pending/${id}`, `videos/${id}`];

/** True only for pending/<uuid> or videos/<uuid> whose uuid is one the test created. */
export function isTrackedKey(key: string, tracked: ReadonlySet<string>): boolean {
  const m = KEY.exec(key);
  return m !== null && tracked.has(m[2]!);
}

export type CleanupPlan = {
  /** Exact keys to delete: tracked, and present in the bucket now. */
  remove: string[];
  /** Keys that appeared during the run but are NOT tracked. They are reported by count and never deleted. */
  unexpected: number;
  /** Keys that existed before the run and are untouched. */
  preExisting: number;
};

export function planCleanup(input: { tracked: ReadonlySet<string>; before: readonly string[]; after: readonly string[] }): CleanupPlan {
  const before = new Set(input.before);
  const remove: string[] = [];
  let unexpected = 0;
  for (const key of input.after) {
    if (before.has(key)) continue; // it was there before the test: never ours to delete
    if (isTrackedKey(key, input.tracked)) remove.push(key);
    else unexpected += 1;
  }
  return { remove: remove.sort(), unexpected, preExisting: before.size };
}

export type MediaFacts = { bytes: number; duration: number; width: number; height: number; played: boolean; mime: string };

/**
 * What must be true of the generated test video before anything hosted is touched. Returns fixed labels, [] when it is fine.
 * The window around the expected length allows for a recorder that stops a moment early or late.
 */
export function mediaProblems(f: MediaFacts, expectedSeconds: number): string[] {
  const out: string[] = [];
  if (!f.mime.startsWith("video/webm")) out.push("not a WebM recording");
  if (!Number.isFinite(f.duration)) out.push("duration unreadable");
  else if (f.duration < expectedSeconds - 0.5 || f.duration > expectedSeconds + 1.5) out.push("duration is not the expected length");
  if (f.bytes < 100 * 1024) out.push("smaller than the 100 KB minimum");
  if (f.bytes > 100 * 1024 * 1024) out.push("larger than the 100 MB maximum");
  if (f.width < 16 || f.height < 16) out.push("no picture");
  if (!f.played) out.push("did not play");
  return out;
}

/**
 * Wraps fetch so that no request can hang for ever. A stalled network then fails that one request quickly with an abort error,
 * instead of leaving a whole setup hook to run into its overall timeout. An existing signal on the request is honoured too.
 */
export function timeoutFetch(ms: number, base: typeof fetch = fetch): typeof fetch {
  return (input, init) => base(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms) });
}

/**
 * Is Supabase Auth answering? One GET of its public health endpoint, bounded by a timeout. Returns a fixed verdict and never
 * the response or the error text (an error message can contain the project URL).
 */
export async function authHealth(baseUrl: string, publishableKey: string, fetchFn: typeof fetch = timeoutFetch(15_000)): Promise<"healthy" | "unhealthy" | "unreachable"> {
  try {
    const res = await fetchFn(`${baseUrl.replace(/\/$/, "")}/auth/v1/health`, { headers: { apikey: publishableKey } });
    return res.status === 200 ? "healthy" : "unhealthy";
  } catch {
    return "unreachable";
  }
}

/** Rejects if the promise has not settled within `ms`. For calls (such as an SDK request) that cannot take an abort signal. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Runs one named setup stage. A failure becomes a short, fixed message naming the stage; the original text is dropped because it can hold a URL. */
export async function stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new Error(`provisioning failed at stage "${name}" (${(e as { name?: string } | null)?.name ?? "error"})`);
  }
}

/** Fixed strings only: what the test may say about a failed call. Never includes a URL, key, id or message. */
export function leaksSensitive(text: string, secrets: readonly string[]): boolean {
  if (/X-Amz-|r2\.cloudflarestorage|\bpending\/|\bvideos\/|sb_secret_|eyJ[A-Za-z0-9_-]{10,}/i.test(text)) return true;
  return secrets.some((s) => s.length >= 6 && text.includes(s));
}
