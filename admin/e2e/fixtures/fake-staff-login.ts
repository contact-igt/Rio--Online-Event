// Stands in for app/staff/login/actions.ts in the offline staff-login test. Every submission is recorded on window.__loginCalls
// (the e-mail and only the LENGTH of the password) and answered from window.__loginScript, one answer per submission.
// "hold" keeps a submission open until window.__loginRelease() is called.

type Answer = { error?: string; email?: string } | "hold" | undefined;

declare global {
  interface Window {
    __loginCalls: { email: string; passwordLength: number }[];
    __loginScript?: Answer[];
    __loginRelease?: () => void;
  }
}

export async function staffSignIn(_prev: unknown, formData: FormData) {
  const email = String(formData.get("email") ?? "");
  (window.__loginCalls ??= []).push({ email, passwordLength: String(formData.get("password") ?? "").length });
  const step = window.__loginScript?.shift();
  if (step === "hold") await new Promise<void>((resolve) => (window.__loginRelease = resolve));
  return step && step !== "hold" ? { email, ...step } : { error: "credentials", email };
}

export async function staffSignOut() {
  return undefined;
}
