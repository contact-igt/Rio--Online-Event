// Stands in for app/events/[slug]/register/video-actions.ts in the offline upload-panel test. It records every call on
// window.__calls and answers from window.__script (a queue per action), so a test can script refusals and failures.
// The default answer is a success with a fake presigned URL on https://r2.test, which the test intercepts.

type Step = { ok: boolean; [k: string]: unknown } | "throw";
type Script = { request?: Step[]; confirm?: Step[] };

declare global {
  interface Window {
    __calls: { fn: "request" | "confirm"; input: Record<string, unknown> }[];
    __script?: Script;
    __refreshed: number;
  }
}

let counter = 0;

export async function requestVideoUpload(input: { type: string; bytes: number }) {
  (window.__calls ??= []).push({ fn: "request", input });
  const step = window.__script?.request?.shift();
  if (step === "throw") throw new Error("network down");
  if (step) return step;
  const id = `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  return { ok: true as const, uploadId: id, url: `https://r2.test/pending/${id}?X-Amz-Signature=fake`, contentType: input.type, expiresAt: "2026-11-05T10:00:00Z" };
}

export async function confirmVideoUpload(input: { uploadId: string }) {
  (window.__calls ??= []).push({ fn: "confirm", input });
  const step = window.__script?.confirm?.shift();
  if (step === "throw") throw new Error("network down");
  return step ?? { ok: true as const, replaced: false };
}
