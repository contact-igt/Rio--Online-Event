// Stands in for app/admin/judges/actions.ts in the offline admin tests. Calls are recorded on window.__adminCalls and answered from
// window.__adminScript (one queue per action); "hold" keeps the request open until window.__adminRelease() is called.
type Step = { ok: boolean; [k: string]: unknown } | "throw" | "hold";
type Fn = "provision" | "reset" | "active";

declare global {
  interface Window {
    __adminCalls: { fn: Fn; input: Record<string, unknown> }[];
    __adminScript?: { provision?: Step[]; reset?: Step[]; active?: Step[] };
    __adminRelease?: () => void;
  }
}

async function answer(fn: Fn, input: Record<string, unknown>) {
  (window.__adminCalls ??= []).push({ fn, input });
  const queue = window.__adminScript?.[fn];
  let step = queue?.shift();
  if (step === "hold") {
    await new Promise<void>((resolve) => (window.__adminRelease = resolve));
    step = queue?.shift(); // after the release, the next queued answer is used (or a plain success)
  }
  if (step === "throw") throw new Error("network down");
  return step && step !== "hold" ? step : { ok: true };
}

export const provisionJudge = (input: Record<string, unknown>) => answer("provision", input);
export const resetJudgePassword = (input: Record<string, unknown>) => answer("reset", input);
export const setJudgeActive = (input: Record<string, unknown>) => answer("active", input);
