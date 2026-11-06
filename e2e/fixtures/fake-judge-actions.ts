// Stands in for app/judge/actions.ts in the offline judge-ui test. Calls are recorded on window.__judgeCalls and answered from
// window.__judgeScript (one queue per action); "hold" keeps the request open until window.__judgeRelease() is called.

type Step = { ok: boolean; [k: string]: unknown } | "throw" | "hold";

declare global {
  interface Window {
    __judgeCalls: { fn: "playback" | "score"; input: Record<string, unknown> }[];
    __judgeScript?: { playback?: Step[]; score?: Step[] };
    __judgeRelease?: () => void;
  }
}

async function answer(fn: "playback" | "score", input: Record<string, unknown>, fallback: Record<string, unknown>) {
  (window.__judgeCalls ??= []).push({ fn, input });
  const step = window.__judgeScript?.[fn]?.shift();
  if (step === "throw") throw new Error("network down");
  if (step === "hold") await new Promise<void>((resolve) => (window.__judgeRelease = resolve));
  return step && step !== "hold" ? step : fallback;
}

export const getPlaybackUrl = (input: Record<string, unknown>) =>
  answer("playback", input, { ok: true, url: "https://r2.test/signed-video?X-Amz-Expires=300", expiresInSeconds: 300 });

export const saveMyScore = (input: Record<string, unknown>) => answer("score", input, { ok: true, status: input.final ? "final" : "draft" });
