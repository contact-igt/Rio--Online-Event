import { beforeEach, describe, expect, it, vi } from "vitest";

// The retry endpoint: a plain 404 for everyone without the right secret and a configured, enabled provider; counts only for the scheduler.

const h = vi.hoisted(() => ({ sweep: vi.fn(), provider: { send: vi.fn() } as unknown, throwDeps: false }));
vi.mock("@/lib/email/outbox", () => ({ sweepOutbox: (...a: unknown[]) => h.sweep(...a) }));
vi.mock("@/lib/email/server", () => ({
  createEmailDeps: () => {
    if (h.throwDeps) throw new Error("Supabase is not configured");
    return { db: {}, provider: h.provider };
  },
}));

const SECRET = "s".repeat(40);
const good = { RIO_EMAIL_ENABLED: "yes", EMAIL_PROVIDER: "resend", EMAIL_API_KEY: "k".repeat(24), EMAIL_FROM: "Rio <noreply@example.org>", CRON_SECRET: SECRET };
const call = async (headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) => {
  const { GET } = await import("./route");
  return GET(new Request("http://localhost/api/email-sweep", { headers }));
};
const setEnv = (e: Record<string, string | undefined>) => {
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(e)) if (v !== undefined) vi.stubEnv(k, v);
};

beforeEach(() => {
  vi.resetModules();
  h.sweep.mockReset().mockResolvedValue({ sent: 2, retry: 1, abandoned: 0, skipped: 0 });
  h.provider = { send: vi.fn() };
  h.throwDeps = false;
  setEnv(good);
});

describe("GET /api/email-sweep", () => {
  it("sends what is due for the scheduler and returns only counts, never cached", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 2, retry: 1, abandoned: 0, skipped: 0 });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.sweep).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: h.provider }), 20);
  });
  it("is a plain 404 without the secret, with a wrong one, or with a malformed header, and sends nothing", async () => {
    for (const headers of [{}, { authorization: "" }, { authorization: "Bearer wrong" }, { authorization: SECRET }, { authorization: `bearer ${SECRET}` }, { authorization: `Bearer ${SECRET}x` }]) {
      const res = await call(headers as Record<string, string>);
      expect(res.status, JSON.stringify(headers)).toBe(404);
      expect(await res.text()).toBe("Not found");
    }
    expect(h.sweep).not.toHaveBeenCalled();
  });
  it("is a 404 whatever the secret, while sending is switched off or not configured, or the secret is too short", async () => {
    for (const env of [{ ...good, RIO_EMAIL_ENABLED: "no" }, { ...good, RIO_EMAIL_ENABLED: undefined }, { ...good, EMAIL_API_KEY: undefined }, { ...good, CRON_SECRET: "short" }, { ...good, CRON_SECRET: undefined }]) {
      setEnv(env);
      vi.resetModules();
      expect((await call(env.CRON_SECRET ? { authorization: `Bearer ${env.CRON_SECRET}` } : { authorization: "Bearer " })).status).toBe(404);
    }
    expect(h.sweep).not.toHaveBeenCalled();
  });
  it("a missing provider is a 404, and a failure inside is a plain 503 that reveals nothing", async () => {
    h.provider = null;
    expect((await call()).status).toBe(404);
    h.provider = { send: vi.fn() };
    h.sweep.mockRejectedValue(new Error("password=hunter2"));
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toMatch(/hunter2|password/);
    h.throwDeps = true;
    expect((await call()).status).toBe(503);
  });
});
