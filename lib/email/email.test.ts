import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { emailAvailable, emailConfigReport, emailEnabled, readEmailConfig } from "./config";
import { queueParticipationEmail, sendOutboxEmail, sweepOutbox, type Claimed, type OutboxDb } from "./outbox";
import { createResendProvider, type EmailMessage, type EmailProvider } from "./provider";
import { renderParticipationEmail } from "./template";

// Everything offline with mocks: no provider, no network, no database.

const KEY = "re_test_0123456789abcdefghij";
const cfg = { provider: "resend" as const, apiKey: KEY, from: "Rio Hospital <noreply@example.org>", replyTo: null };
const REF = "RIO-AB12C-DE34F";
const env = { RIO_EMAIL_ENABLED: "yes", EMAIL_PROVIDER: "resend", EMAIL_API_KEY: KEY, EMAIL_FROM: "Rio Hospital <noreply@example.org>" };

describe("the switch and the configuration", () => {
  it("only the exact value yes turns sending on; every other spelling is off", () => {
    expect(emailEnabled({ RIO_EMAIL_ENABLED: "yes" })).toBe(true);
    for (const v of [undefined, "", "no", "YES", "Yes", " yes", "true", "1", "on"]) expect(emailEnabled({ RIO_EMAIL_ENABLED: v }), JSON.stringify(v)).toBe(false);
  });
  it("sending needs the switch AND a complete configuration", () => {
    expect(emailAvailable(env)).toBe(true);
    expect(emailAvailable({ ...env, RIO_EMAIL_ENABLED: "no" })).toBe(false);
    expect(emailAvailable({ ...env, EMAIL_API_KEY: "short" })).toBe(false);
    expect(emailAvailable({ ...env, EMAIL_PROVIDER: "smtp" })).toBe(false);
    expect(emailAvailable({ ...env, EMAIL_FROM: "not an address" })).toBe(false);
    expect(emailAvailable({ RIO_EMAIL_ENABLED: "yes" })).toBe(false);
  });
  it("refuses a sender, reply address or key with a line break (header injection)", () => {
    expect(readEmailConfig({ ...env, EMAIL_FROM: "Rio <a@example.org>\r\nBcc: x@evil.test" })).toBeNull();
    expect(readEmailConfig({ ...env, EMAIL_REPLY_TO: "a@example.org\nBcc: x@evil.test" })).toBeNull();
    expect(readEmailConfig({ ...env, EMAIL_API_KEY: `${KEY}\nX: y` })).toBeNull();
    expect(readEmailConfig({ ...env, EMAIL_REPLY_TO: "help@example.org" })?.replyTo).toBe("help@example.org");
  });
  it("the report names settings, never values", () => {
    const r = emailConfigReport({ ...env, EMAIL_API_KEY: "short" });
    expect(r).toEqual({ ok: false, provider: "ok", apiKey: "badFormat", from: "ok" });
    expect(JSON.stringify(emailConfigReport(env))).not.toContain(KEY);
  });
});

describe("the template", () => {
  const mail = renderParticipationEmail({ eventId: 4, reference: REF });
  it("names the competition in both languages, the reference and the announcement date, in the subject, text and HTML", () => {
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain("Little Speaker");
      expect(part).toContain("குட்டிப் பேச்சாளர்");
      expect(part).toContain(REF);
      expect(part).toContain("The winners announcement date will be confirmed later.");
      expect(part).not.toMatch(/\d{1,2}\s+(Nov|November)|நவம்பர்/); // no unapproved date
    }
    expect(mail.subject).toContain("Little Speaker");
    expect(mail.subject).toContain(REF);
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });
  it("contains no link, no attachment reference, no storage address and no video address", () => {
    for (const part of [mail.text, mail.html, mail.subject]) {
      expect(part).not.toMatch(/https?:|www\.|href=|src=|<img|<script|<iframe|mailto:|cid:|data:|r2\.|cloudflare|videos\/|pending\/|X-Amz|\.mp4|\.webm|\.mov/i);
    }
    expect(mail.html).toContain("not attached");
  });
  it("says the entry is final, and does not claim anything about results beyond the announcement date", () => {
    expect(mail.text).toMatch(/final and cannot be changed/);
    expect(mail.text).not.toMatch(/winner of|you won|certificate (is|has been) (attached|ready)/i);
  });
  it("renders every one of the six competitions", () => {
    for (let id = 1; id <= 6; id++) expect(renderParticipationEmail({ eventId: id, reference: REF }).html).toContain(REF);
  });
  it("refuses an unknown competition and any reference that is not an exact entry code, so nothing can be injected", () => {
    expect(() => renderParticipationEmail({ eventId: 0, reference: REF })).toThrow();
    expect(() => renderParticipationEmail({ eventId: 7, reference: REF })).toThrow();
    for (const bad of ["", "RIO-1", "rio-ab12c-de34f", `${REF}<script>`, `${REF}\nBcc: x@evil.test`, `<b>${REF}</b>`, "RIO-AB12C-DE34F-X"]) expect(() => renderParticipationEmail({ eventId: 1, reference: bad }), JSON.stringify(bad)).toThrow();
  });
  it("is well-formed HTML with a language and charset", () => {
    expect(mail.html).toMatch(/^<!doctype html>/i);
    expect(mail.html).toContain('<meta charset="utf-8">');
    expect(mail.html).toContain('lang="ta"');
    expect((mail.html.match(/<div/g) ?? []).length).toBe((mail.html.match(/<\/div>/g) ?? []).length);
  });
});

describe("the provider", () => {
  const message = { to: "parent@example.org", subject: "Entry received", html: "<p>x</p>", text: "x", idempotencyKey: "rio-participation-abc" };
  const ok = (status: number) => vi.fn(async () => new Response("provider text with parent@example.org", { status }));

  it("sends one POST to the provider with the key only in the Authorization header, an idempotency key, and the message", async () => {
    const fetchFn = ok(200);
    expect(await createResendProvider({ ...cfg, replyTo: "help@example.org" }, fetchFn as never).send(message)).toEqual({ ok: true });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers["Idempotency-Key"]).toBe("rio-participation-abc");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ from: cfg.from, to: ["parent@example.org"], subject: "Entry received", reply_to: "help@example.org" });
    expect(String(init.body)).not.toContain(KEY);
  });
  it("tells a retryable failure (rate limit, server error, timeout, network) from a permanent one (refused request)", async () => {
    const send = (fetchFn: unknown) => createResendProvider(cfg, fetchFn as never).send(message);
    for (const status of [429, 500, 502, 503, 408]) expect(await send(ok(status)), String(status)).toEqual({ ok: false, retryable: true });
    for (const status of [400, 401, 403, 404, 422]) expect(await send(ok(status)), String(status)).toEqual({ ok: false, retryable: false });
    expect(await send(vi.fn(async () => { throw new Error("socket hang up https://api.resend.com"); }))).toEqual({ ok: false, retryable: true });
  });
  it("never returns the key, the address or the provider's own text", async () => {
    const results = [await createResendProvider(cfg, ok(422) as never).send(message), await createResendProvider(cfg, vi.fn(async () => { throw new Error(KEY); }) as never).send(message)];
    expect(JSON.stringify(results)).not.toMatch(/re_test|parent@|provider text/);
  });
  it("refuses a recipient with a line break, a second address or markup, and a header-breaking subject, without calling the provider", async () => {
    const fetchFn = ok(200);
    const p = createResendProvider(cfg, fetchFn as never);
    for (const to of ["a@example.org\r\nBcc: x@evil.test", "a@example.org, b@example.org", "<a@example.org>", "a b@example.org", "", "no-at-sign", `${"x".repeat(250)}@example.org`]) expect(await p.send({ ...message, to }), JSON.stringify(to)).toEqual({ ok: false, retryable: false });
    expect(await p.send({ ...message, subject: "ok\r\nBcc: x@evil.test" })).toEqual({ ok: false, retryable: false });
    expect(await p.send({ ...message, idempotencyKey: "has space" })).toEqual({ ok: false, retryable: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

function fakeDb(over: Partial<OutboxDb> & { claims?: (Claimed | null)[] } = {}) {
  const queue = [...(over.claims ?? [{ to: "parent@example.org", reference: REF, eventId: 4, attempt: 1 }])];
  const db = {
    enqueue: over.enqueue ?? vi.fn(async () => "outbox-1"),
    claim: over.claim ?? vi.fn(async () => queue.shift() ?? null),
    finish: over.finish ?? vi.fn(async () => undefined),
    due: over.due ?? vi.fn(async () => ["a", "b", "c"]),
  } satisfies OutboxDb;
  return db;
}
const okProvider = () => ({ send: vi.fn(async (message: EmailMessage) => (void message, { ok: true as const })) }) satisfies EmailProvider;

describe("sendOutboxEmail", () => {
  it("claims first, sends once with the row id as the idempotency key, then records 'sent'", async () => {
    const db = fakeDb();
    const provider = okProvider();
    const order: string[] = [];
    (db.claim as ReturnType<typeof vi.fn>).mockImplementation(async () => (order.push("claim"), { to: "parent@example.org", reference: REF, eventId: 4, attempt: 1 }));
    provider.send.mockImplementation(async () => (order.push("send"), { ok: true as const }));
    (db.finish as ReturnType<typeof vi.fn>).mockImplementation(async () => void order.push("finish"));
    expect(await sendOutboxEmail({ db, provider }, "outbox-1")).toBe("sent");
    expect(order).toEqual(["claim", "send", "finish"]);
    expect(provider.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: "parent@example.org", idempotencyKey: "rio-participation-outbox-1" }));
    expect(db.finish).toHaveBeenCalledExactlyOnceWith("outbox-1", "sent");
  });
  it("what it sends has the competition, the reference and no link", async () => {
    const provider = okProvider();
    await sendOutboxEmail({ db: fakeDb(), provider }, "outbox-1");
    const sent = provider.send.mock.calls[0]![0] as { html: string; text: string; subject: string };
    expect(sent.subject + sent.text + sent.html).toContain(REF);
    expect(sent.subject + sent.text + sent.html).not.toMatch(/https?:|href=/);
  });
  it("sends NOTHING when the row cannot be claimed (already sent, being sent, not due, not finalized): no duplicate", async () => {
    const provider = okProvider();
    expect(await sendOutboxEmail({ db: fakeDb({ claims: [null] }), provider }, "outbox-1")).toBe("skipped");
    expect(provider.send).not.toHaveBeenCalled();
  });
  it("two requests at once send exactly one e-mail, because only one can claim", async () => {
    const db = fakeDb({ claims: [{ to: "parent@example.org", reference: REF, eventId: 4, attempt: 1 }, null] });
    const provider = okProvider();
    const results = await Promise.all([sendOutboxEmail({ db, provider }, "outbox-1"), sendOutboxEmail({ db, provider }, "outbox-1")]);
    expect(results.sort()).toEqual(["sent", "skipped"]);
    expect(provider.send).toHaveBeenCalledOnce();
  });
  it("a retryable failure is recorded as 'transient' (retry later); a permanent one as 'permanent'; neither throws", async () => {
    const transient = fakeDb();
    expect(await sendOutboxEmail({ db: transient, provider: { send: async () => ({ ok: false, retryable: true }) } }, "o")).toBe("retry");
    expect(transient.finish).toHaveBeenCalledExactlyOnceWith("o", "transient");
    const permanent = fakeDb();
    expect(await sendOutboxEmail({ db: permanent, provider: { send: async () => ({ ok: false, retryable: false }) } }, "o")).toBe("abandoned");
    expect(permanent.finish).toHaveBeenCalledExactlyOnceWith("o", "permanent");
    const thrown = fakeDb();
    expect(await sendOutboxEmail({ db: thrown, provider: { send: async () => { throw new Error("boom"); } } }, "o")).toBe("retry");
    expect(thrown.finish).toHaveBeenCalledExactlyOnceWith("o", "transient");
  });
  it("the eighth failed attempt ends as abandoned", async () => {
    const db = fakeDb({ claims: [{ to: "parent@example.org", reference: REF, eventId: 4, attempt: 8 }] });
    expect(await sendOutboxEmail({ db, provider: { send: async () => ({ ok: false, retryable: true }) } }, "o")).toBe("abandoned");
  });
  it("a row that can never be rendered (unknown competition, bad reference) is abandoned and not sent", async () => {
    for (const claim of [{ to: "parent@example.org", reference: REF, eventId: 99, attempt: 1 }, { to: "parent@example.org", reference: "bad", eventId: 4, attempt: 1 }]) {
      const db = fakeDb({ claims: [claim] });
      const provider = okProvider();
      expect(await sendOutboxEmail({ db, provider }, "o")).toBe("abandoned");
      expect(provider.send).not.toHaveBeenCalled();
      expect(db.finish).toHaveBeenCalledExactlyOnceWith("o", "permanent");
    }
  });
  it("if recording the outcome fails after a successful send, the result is still 'sent' (the idempotency key covers a later retry)", async () => {
    const db = fakeDb({ finish: vi.fn(async () => { throw new Error("db down"); }) });
    expect(await sendOutboxEmail({ db, provider: okProvider() }, "o")).toBe("sent");
  });
  it("an unreachable database means nothing is sent", async () => {
    const provider = okProvider();
    expect(await sendOutboxEmail({ db: fakeDb({ claim: vi.fn(async () => { throw new Error("db down"); }) }), provider }, "o")).toBe("skipped");
    expect(provider.send).not.toHaveBeenCalled();
  });
});

describe("queueParticipationEmail (after a final submission)", () => {
  it("records the intention and tries to send once when a provider is configured", async () => {
    const db = fakeDb();
    const provider = okProvider();
    expect(await queueParticipationEmail({ db, provider }, "sub-1")).toBe("sent");
    expect(db.enqueue).toHaveBeenCalledExactlyOnceWith("sub-1");
    expect(provider.send).toHaveBeenCalledOnce();
  });
  it("with sending off or not configured (no provider) it only records the intention: nothing is sent", async () => {
    const db = fakeDb();
    expect(await queueParticipationEmail({ db, provider: null }, "sub-1")).toBe("queued");
    expect(db.enqueue).toHaveBeenCalledOnce();
    expect(db.claim).not.toHaveBeenCalled();
  });
  it("a failure to record (for example the outbox migration is not applied) never throws and sends nothing", async () => {
    const provider = okProvider();
    expect(await queueParticipationEmail({ db: fakeDb({ enqueue: vi.fn(async () => { throw new Error("not_finalized"); }) }), provider }, "sub-1")).toBe("failed");
    expect(provider.send).not.toHaveBeenCalled();
  });
  it("a failing provider leaves the intention queued for a retry and never throws", async () => {
    const db = fakeDb();
    expect(await queueParticipationEmail({ db, provider: { send: async () => { throw new Error("boom"); } } }, "sub-1")).toBe("queued");
    expect(db.finish).toHaveBeenCalledExactlyOnceWith("outbox-1", "transient");
  });
});

describe("sweepOutbox (the retry worker)", () => {
  it("tries each due row once and counts the outcomes", async () => {
    const claims: (Claimed | null)[] = [{ to: "a@example.org", reference: REF, eventId: 1, attempt: 2 }, null, { to: "c@example.org", reference: REF, eventId: 2, attempt: 3 }];
    const sends = [{ ok: true as const }, { ok: false as const, retryable: false }];
    const provider: EmailProvider = { send: vi.fn(async () => sends.shift()!) };
    expect(await sweepOutbox({ db: fakeDb({ claims }), provider }, 20)).toEqual({ sent: 1, retry: 0, abandoned: 1, skipped: 1 });
  });
  it("an unreachable database sends nothing and does not throw", async () => {
    const provider = okProvider();
    expect(await sweepOutbox({ db: fakeDb({ due: vi.fn(async () => { throw new Error("down"); }) }), provider })).toEqual({ sent: 0, retry: 0, abandoned: 0, skipped: 0 });
    expect(provider.send).not.toHaveBeenCalled();
  });
});

describe("the email code's source", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  it("never logs, and only config.ts reads the API key", () => {
    for (const f of ["./config.ts", "./provider.ts", "./outbox.ts", "./server.ts", "./template.ts"]) expect(read(f), f).not.toMatch(/console\./);
    for (const f of ["./provider.ts", "./outbox.ts", "./server.ts", "./template.ts"]) expect(read(f), f).not.toMatch(/process\.env/);
  });
  it("has no reference to private storage, signed links or the browser", () => {
    for (const f of ["./config.ts", "./provider.ts", "./outbox.ts", "./server.ts", "./template.ts"]) {
      expect(read(f), f).not.toMatch(/object-store|presign|videos\/|R2_|NEXT_PUBLIC|"use client"|localStorage/);
    }
  });
});
