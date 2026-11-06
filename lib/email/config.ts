// Confirmation e-mail settings. Server-only values; nothing here is ever sent to the browser except the single boolean "will an e-mail be sent".
// Sending stays OFF until RIO_EMAIL_ENABLED is exactly "yes" AND the provider is configured (and has been tested by the owner).

type Env = Record<string, string | undefined>;

export const emailEnabled = (env: Env = process.env) => env.RIO_EMAIL_ENABLED === "yes";

export type EmailConfig = { provider: "resend"; apiKey: string; from: string; replyTo: string | null };

const FROM = /^(?:[^<>\r\n"]{1,80}\s)?<?[^\s<>@"]+@[^\s<>@"]+\.[^\s<>@"]+>?$/;

/** Null unless the provider, its key and a sender address are all present and look right. Header injection (CR/LF) is refused. */
export function readEmailConfig(env: Env = process.env): EmailConfig | null {
  const provider = env.EMAIL_PROVIDER?.trim();
  const apiKey = env.EMAIL_API_KEY?.trim() ?? "";
  const from = env.EMAIL_FROM?.trim() ?? "";
  const replyTo = env.EMAIL_REPLY_TO?.trim() || null;
  if (provider !== "resend" || apiKey.length < 16 || /\s/.test(apiKey)) return null;
  if (!FROM.test(from) || /[\r\n]/.test(from)) return null;
  if (replyTo !== null && (!FROM.test(replyTo) || /[\r\n]/.test(replyTo))) return null;
  return { provider, apiKey, from, replyTo };
}

/** ok / missing / badFormat for each setting, by name only (never a value), for a configuration check. */
export function emailConfigReport(env: Env = process.env): { ok: boolean; provider: "ok" | "missing" | "badFormat"; apiKey: "ok" | "missing" | "badFormat"; from: "ok" | "missing" | "badFormat" } {
  const state = (v: string | undefined, valid: boolean): "ok" | "missing" | "badFormat" => (!v?.trim() ? "missing" : valid ? "ok" : "badFormat");
  const provider = state(env.EMAIL_PROVIDER, env.EMAIL_PROVIDER?.trim() === "resend");
  const apiKey = state(env.EMAIL_API_KEY, (env.EMAIL_API_KEY?.trim().length ?? 0) >= 16 && !/\s/.test(env.EMAIL_API_KEY?.trim() ?? ""));
  const from = state(env.EMAIL_FROM, FROM.test(env.EMAIL_FROM?.trim() ?? "") && !/[\r\n]/.test(env.EMAIL_FROM ?? ""));
  return { ok: provider === "ok" && apiKey === "ok" && from === "ok", provider, apiKey, from };
}

/** Sending is possible only with the switch AND a complete configuration. */
export const emailAvailable = (env: Env = process.env) => emailEnabled(env) && readEmailConfig(env) !== null;
