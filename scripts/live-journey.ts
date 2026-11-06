// Guards and pure helpers for the approval-gated LIVE journey test (e2e-live/journey.livejourney.ts). Plain TypeScript with no path
// aliases, so Playwright and Vitest both load it. Nothing here makes a network call or prints a value; every message is a fixed string.
//
// What it protects:
//   * the run needs THREE typed confirmations (project ref, bucket name, and a journey confirmation naming the ref again);
//   * only the dev project and a dev-looking bucket; the three feature switches must be OFF in the test process (the test turns
//     them on for its own web server only);
//   * the run refuses to start unless DEV is in the expected empty state, so it can never touch somebody else's data;
//   * a signed playback link must be short-lived, for the bucket host, and only for the video the test created.

import { assertUploadTarget, UploadGuardError, type MediaFacts } from "./live-upload";

export class JourneyGuardError extends Error {
  override name = "JourneyGuardError";
}

type Env = Record<string, string | undefined>;
const REF = /^[a-z0-9]{20}$/;

export function assertJourneyTarget(env: Env): { bucket: string; devRef: string } {
  let bucket: string;
  try {
    ({ bucket } = assertUploadTarget({ ...env, RIO_UPLOADS_ENABLED: undefined })); // bucket, R2 and Supabase settings, typed bucket confirmation
  } catch (e) {
    if (e instanceof UploadGuardError) throw new JourneyGuardError(e.message);
    throw e;
  }
  const devRef = env.RIO_DEV_PROJECT_REF ?? "";
  if (!REF.test(devRef)) throw new JourneyGuardError("RIO_DEV_PROJECT_REF is missing or not a 20-character project ref.");
  if (env.RIO_LIVE_CONFIRM !== devRef) throw new JourneyGuardError("Set RIO_LIVE_CONFIRM to the dev project ref to allow the live journey test.");
  if (env.RIO_LIVE_JOURNEY_CONFIRM !== devRef) throw new JourneyGuardError("Set RIO_LIVE_JOURNEY_CONFIRM to the dev project ref to allow ONE run of the live journey test.");
  for (const name of ["RIO_UPLOADS_ENABLED", "RIO_FINALIZE_ENABLED", "RIO_PLAYBACK_ENABLED"]) {
    if (env[name] === "yes") throw new JourneyGuardError("A feature switch is already on in the test process; the test turns them on for its own server only.");
  }
  if (env.RIO_CONFIRM_PUSH) throw new JourneyGuardError("RIO_CONFIRM_PUSH must not be set while running tests.");
  return { bucket, devRef };
}

/** Counts and settings read BEFORE any write. Returns fixed labels for everything that is not the expected empty DEV state. */
export type Baseline = {
  counts: Record<"submissions" | "video_uploads" | "judge_assignments" | "scores" | "winners" | "judge_profiles", number>;
  settings: { submissions_open_at: unknown; submissions_close_at: unknown; current_consent_version: unknown; results_publish_at: unknown };
  bucketKeys: number;
  events: number;
};

export function preflightProblems(b: Baseline): string[] {
  const out: string[] = [];
  for (const [table, n] of Object.entries(b.counts)) if (n !== 0) out.push(`${table} is not empty`);
  const s = b.settings;
  if (s.submissions_open_at !== null || s.submissions_close_at !== null || s.current_consent_version !== null) out.push("registration is not closed");
  if (s.results_publish_at !== null) out.push("results are scheduled for publication");
  if (b.bucketKeys !== 0) out.push("the bucket is not empty");
  if (b.events !== 6) out.push("the six events are not all present");
  return out;
}

/** What is wrong with a signed playback link. Never returns or logs the link itself. */
export function playbackLinkProblems(link: string, opts: { host: string; videoKey: string; maxSeconds: number }): string[] {
  const out: string[] = [];
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return ["not a URL"];
  }
  if (u.protocol !== "https:") out.push("not https");
  if (u.hostname !== opts.host) out.push("not the bucket host");
  if (!u.pathname.endsWith(`/${opts.videoKey}`)) out.push("not the expected object");
  const expires = Number(u.searchParams.get("X-Amz-Expires"));
  if (!Number.isFinite(expires) || expires <= 0) out.push("no lifetime");
  else if (expires > opts.maxSeconds) out.push("lives longer than allowed");
  if (!u.searchParams.get("X-Amz-Signature")) out.push("not signed");
  return out;
}

/** The same link with its signature altered (must be refused by the bucket) and with no signature at all. */
export function tamperedLinks(link: string): { badSignature: string; unsigned: string } {
  const u = new URL(link);
  const sig = u.searchParams.get("X-Amz-Signature") ?? "";
  const flipped = sig.length ? (sig.startsWith("0") ? "1" : "0") + sig.slice(1) : "0";
  const bad = new URL(link);
  bad.searchParams.set("X-Amz-Signature", flipped);
  return { badSignature: bad.toString(), unsigned: `${u.origin}${u.pathname}` };
}

/**
 * The order cleanup deletes the rows this run created: children before parents, so no foreign key blocks it, and the audit log is
 * NEVER in the list (it is append-only evidence). The test asserts it deletes nothing outside this list.
 */
export const CLEANUP_ORDER = ["winners", "scores", "judge_assignments", "submissions", "judge_profiles", "user_roles", "auth_users", "event_settings"] as const;

/**
 * What must be true of the generated MP4 before anything hosted is touched. Fixed labels, [] when fine. `facts` were measured by
 * Chrome decoding and playing the converted file; `header` was read from the file's own movie header.
 */
export function mp4Problems(facts: MediaFacts, header: { fragmented: boolean; seconds: number; samples: number }, expectedSeconds: number): string[] {
  const out: string[] = [];
  if (!facts.mime.startsWith("video/mp4")) out.push("not an MP4");
  if (header.fragmented) out.push("still fragmented (header duration unusable)");
  if (!Number.isFinite(facts.duration)) out.push("Chrome cannot read a duration");
  else if (facts.duration < expectedSeconds - 0.5 || facts.duration > expectedSeconds + 1.5) out.push("duration is not the expected length");
  if (!(Math.abs(header.seconds - facts.duration) <= 0.25)) out.push("header duration disagrees with what Chrome measured");
  if (header.samples < Math.floor(expectedSeconds * 5)) out.push("far too few video samples");
  if (facts.bytes < 100 * 1024) out.push("smaller than the 100 KB minimum");
  if (facts.bytes > 100 * 1024 * 1024) out.push("larger than the 100 MB maximum");
  if (facts.width < 16 || facts.height < 16) out.push("no picture");
  if (!facts.played) out.push("did not play");
  return out;
}
