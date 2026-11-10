// Stands in for app/events/[slug]/register/submit-actions.ts in the offline submit-entry test. It records every call on
// window.__submitCalls and answers from window.__submitScript (a queue), so a test can script refusals and failures.
// `hold` keeps the request open until the test calls window.__submitRelease().

type Step = { ok: boolean; [k: string]: unknown } | "throw" | "hold";

declare global {
  interface Window {
    __submitCalls: Record<string, unknown>[];
    __submitScript?: Step[];
    __submitRelease?: () => void;
  }
}

export async function submitEntry(input: Record<string, unknown>) {
  (window.__submitCalls ??= []).push(input);
  const step = window.__submitScript?.shift();
  if (step === "throw") throw new Error("network down");
  if (step === "hold") await new Promise<void>((resolve) => (window.__submitRelease = resolve));
  return step && step !== "hold" ? step : { ok: true as const, already: false };
}
