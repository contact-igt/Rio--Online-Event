// Stands in for app/admin/judges/actions.ts in the offline admin tests. Calls are recorded on window.__adminCalls and answered from
// window.__adminScript (one queue per action); "hold" keeps the request open until window.__adminRelease() is called.
type Step = { ok: boolean; [k: string]: unknown } | "throw" | "hold";

declare global {
  interface Window {
    __adminCalls: { fn: "invite" | "active"; input: Record<string, unknown> }[];
    __adminScript?: { invite?: Step[]; active?: Step[] };
    __adminRelease?: () => void;
  }
}

async function answer(fn: "invite" | "active", input: Record<string, unknown>) {
  (window.__adminCalls ??= []).push({ fn, input });
  const step = window.__adminScript?.[fn]?.shift();
  if (step === "throw") throw new Error("network down");
  if (step === "hold") await new Promise<void>((resolve) => (window.__adminRelease = resolve));
  return step && step !== "hold" ? step : { ok: true };
}

export const inviteJudge = (input: Record<string, unknown>) => answer("invite", input);
export const setJudgeActive = (input: Record<string, unknown>) => answer("active", input);
