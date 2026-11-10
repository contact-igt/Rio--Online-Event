import type { EmailConfig } from "./config";

// The one place that talks to the outside e-mail service (Resend's HTTPS API; no extra dependency). Server-only. The API key is read from the
// server's own settings, used only in the Authorization header, and never returned, logged or placed in a result. A result says only whether
// the send worked and whether trying again could help; the provider's own text is dropped (it can echo an address).

export type EmailMessage = { to: string; subject: string; html: string; text: string; idempotencyKey: string };
export type SendResult = { ok: true } | { ok: false; retryable: boolean };
export type EmailProvider = { send(message: EmailMessage): Promise<SendResult> };

const ADDRESS = /^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]{2,}$/;
const ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 10_000;

export function createResendProvider(cfg: EmailConfig, fetchFn: typeof fetch = fetch): EmailProvider {
  return {
    async send(m) {
      // Never build a header or a recipient from anything that could contain a line break or a second address.
      if (!ADDRESS.test(m.to) || m.to.length > 254 || /[\r\n]/.test(m.subject) || !/^[\w.-]{1,200}$/.test(m.idempotencyKey)) return { ok: false, retryable: false };
      try {
        const res = await fetchFn(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": m.idempotencyKey },
          body: JSON.stringify({ from: cfg.from, to: [m.to], subject: m.subject, html: m.html, text: m.text, ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}) }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status >= 200 && res.status < 300) return { ok: true };
        return { ok: false, retryable: res.status === 429 || res.status >= 500 || res.status === 408 };
      } catch {
        return { ok: false, retryable: true }; // network failure or timeout: worth trying again
      }
    },
  };
}
