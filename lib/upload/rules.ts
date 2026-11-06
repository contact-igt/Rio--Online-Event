// The rules for an entry video, shared by the browser (to tell the parent early) and the server (to refuse anything
// that does not meet them). The browser's checks are a convenience only: a determined user can bypass them, so the
// server repeats the type and size rules, and the size and type of the stored object are verified with HeadObject
// before a video is attached. The duration check is NOT authoritative anywhere yet: reading a duration needs the
// video to be decoded, which only the browser does today. A server-side probe is a follow-up (see PROJECT_BRIEF.md).
// Plain TypeScript with no path aliases so the browser tests can bundle it.

export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MIN_VIDEO_BYTES = 100 * 1024; // anything smaller cannot be 30 seconds of video
export const MIN_SECONDS = 30;
export const MAX_SECONDS = 90;
export const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;
export type VideoType = (typeof VIDEO_TYPES)[number];

const BY_EXTENSION: Record<string, VideoType> = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" };

export const isVideoType = (t: string): t is VideoType => (VIDEO_TYPES as readonly string[]).includes(t);

/** The MIME type to trust for a picked file: the browser's own, or (when it gives none) the file extension's. */
export function videoTypeOf(file: { type: string; name: string }): string {
  if (file.type) return file.type.toLowerCase();
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return BY_EXTENSION[ext] ?? "";
}

export type VideoProblem = "type" | "tooBig" | "tooSmall" | "tooShort" | "tooLong" | "unreadable";

/** Everything that can go wrong with an upload, for the screen to explain. */
export type UploadErrorCode =
  | VideoProblem
  | "invalid"
  | "notFound"
  | "closed"
  | "locked"
  | "tooMany"
  | "notCurrent"
  | "expired"
  | "missing"
  | "mismatch"
  | "unavailable";

/** What was declared about the video. The duration is in seconds, or null if the browser could not read it. */
export type VideoMeta = { type: string; bytes: number; seconds: number | null };

/** The cheap checks (type and size), done before the browser spends time decoding a file. */
export function checkFile(meta: { type: string; bytes: number }): VideoProblem | null {
  if (!isVideoType(meta.type)) return "type";
  if (!Number.isFinite(meta.bytes) || meta.bytes < MIN_VIDEO_BYTES) return "tooSmall";
  if (meta.bytes > MAX_VIDEO_BYTES) return "tooBig";
  return null;
}

/** Null when the video meets the rules; otherwise the first rule it breaks. Seconds are rounded to the nearest whole second. */
export function checkVideo(meta: VideoMeta): VideoProblem | null {
  const basic = checkFile(meta);
  if (basic) return basic;
  if (meta.seconds === null || !Number.isFinite(meta.seconds)) return "unreadable";
  const s = Math.round(meta.seconds);
  if (s < MIN_SECONDS) return "tooShort";
  if (s > MAX_SECONDS) return "tooLong";
  return null;
}
