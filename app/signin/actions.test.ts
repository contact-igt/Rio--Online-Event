import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The actions run against a fake cookie jar and a fake Supabase client: the tests prove OUR behaviour
// (validation, cooldown, rate limits, redirects, cookies, error mapping). Real Supabase behaviour is
// covered by the dev-project tests (see e2e/auth.spec.ts and e2e-live/).

const h = vi.hoisted(() => {
  class Redirect extends Error {
    constructor(public url: string) {
      super(`redirect:${url}`);
    }
  }
  return {
    Redirect,
    jar: new Map<string, { value: string; options: Record<string, unknown> }>(),
    headers: new Map<string, string>(),
    broken: { config: false },
    auth: { signInWithOtp: vi.fn(), verifyOtp: vi.fn(), signOut: vi.fn() },
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const c = h.jar.get(name);
      return c && c.value ? { name, value: c.value } : undefined;
    },
    set: (name: string, value: string, options: Record<string, unknown> = {}) => void h.jar.set(name, { value, options }),
  }),
  headers: async () => ({ get: (name: string) => h.headers.get(name.toLowerCase()) ?? null }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new h.Redirect(url);
  },
}));
vi.mock("@/lib/supabase/server", async () => {
  const { SupabaseConfigError } = await import("@/lib/supabase/config");
  return {
    createClient: async () => {
      if (h.broken.config) throw new SupabaseConfigError("not configured");
      return { auth: h.auth };
    },
  };
});

type Actions = typeof import("./actions");
let actions: Actions;

const form = (values: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
};

/** Run an action; a redirect is returned as data instead of thrown. */
async function run<T>(fn: () => Promise<T>): Promise<{ state?: T; redirect?: string }> {
  try {
    return { state: await fn() };
  } catch (e) {
    if (e instanceof h.Redirect) return { redirect: e.url };
    throw e;
  }
}

const pendingCookie = () => {
  const c = h.jar.get("rio_otp");
  return c && c.value ? (JSON.parse(c.value) as { email: string; sentAt: number }) : null;
};
const seedPending = (email: string, ageMs: number) =>
  h.jar.set("rio_otp", { value: JSON.stringify({ email, sentAt: Date.now() - ageMs }), options: {} });

beforeEach(async () => {
  vi.resetModules(); // fresh rate limiters for every test
  h.jar.clear();
  h.headers.clear();
  h.headers.set("x-forwarded-for", "203.0.113.7");
  h.broken.config = false;
  h.auth.signInWithOtp.mockReset().mockResolvedValue({ data: {}, error: null });
  h.auth.verifyOtp.mockReset().mockResolvedValue({ data: { session: { access_token: "x" } }, error: null });
  h.auth.signOut.mockReset().mockResolvedValue({ error: null });
  actions = await import("./actions");
});

describe("requestCode", () => {
  it("rejects an invalid email without calling Supabase or setting a cookie", async () => {
    const { state } = await run(() => actions.requestCode(undefined, form({ email: "not-an-email" })));
    expect(state?.fieldError?.en).toMatch(/valid email/i);
    expect(h.auth.signInWithOtp).not.toHaveBeenCalled();
    expect(pendingCookie()).toBeNull();
  });

  it("sends a six-digit code request for a normalized email, stores it in an httpOnly cookie, and goes to the verify screen", async () => {
    const { redirect } = await run(() => actions.requestCode(undefined, form({ email: "  Parent@Example.com ", event: "kutti-pesalar" })));
    expect(h.auth.signInWithOtp).toHaveBeenCalledExactlyOnceWith({ email: "parent@example.com", options: { shouldCreateUser: true } });
    expect(redirect).toBe("/signin/verify?event=kutti-pesalar");
    expect(pendingCookie()?.email).toBe("parent@example.com");
    const options = h.jar.get("rio_otp")!.options;
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/signin", maxAge: 900 });
  });

  it("drops an unknown or hostile event instead of redirecting to it", async () => {
    for (const evil of ["https://evil.example", "//evil.example", "/account", "nope"]) {
      h.jar.clear();
      const { redirect } = await run(() => actions.requestCode(undefined, form({ email: `a${evil.length}@example.com`, event: evil })));
      expect(redirect, evil).toBe("/signin/verify");
    }
  });

  it("enforces the 60-second resend cooldown for the same address, but not for another", async () => {
    await run(() => actions.requestCode(undefined, form({ email: "a@example.com" })));
    const again = await run(() => actions.requestCode(undefined, form({ email: "a@example.com" })));
    expect(again.redirect).toBeUndefined();
    expect(again.state?.error?.en).toMatch(/Wait \d+ seconds/);
    expect(h.auth.signInWithOtp).toHaveBeenCalledTimes(1);
    const other = await run(() => actions.requestCode(undefined, form({ email: "b@example.com" })));
    expect(other.redirect).toBe("/signin/verify");
    expect(h.auth.signInWithOtp).toHaveBeenCalledTimes(2);
  });

  it("shows the rate-limit message when Supabase refuses to send another email, and sets no cookie", async () => {
    h.auth.signInWithOtp.mockResolvedValue({ data: {}, error: { code: "over_email_send_rate_limit", status: 429, message: "x" } });
    const { state, redirect } = await run(() => actions.requestCode(undefined, form({ email: "a@example.com" })));
    expect(redirect).toBeUndefined();
    expect(state?.error?.en).toMatch(/Too many attempts/);
    expect(pendingCookie()).toBeNull();
  });

  it("reports a generic failure, or 'unavailable' when the project is not configured", async () => {
    h.auth.signInWithOtp.mockResolvedValue({ data: {}, error: { code: "unexpected_failure", message: "smtp boom" } });
    expect((await run(() => actions.requestCode(undefined, form({ email: "a@example.com" })))).state?.error?.en).toMatch(/could not send/i);
    h.broken.config = true;
    expect((await run(() => actions.requestCode(undefined, form({ email: "c@example.com" })))).state?.error?.en).toMatch(/unavailable/i);
  });

  it("limits requests per IP address and per email address", async () => {
    let last;
    for (let i = 0; i < 9; i++) last = await run(() => actions.requestCode(undefined, form({ email: `user${i}@example.com` })));
    expect(last?.state?.error?.en).toMatch(/Too many attempts/); // 9th request from one IP
    expect(h.auth.signInWithOtp).toHaveBeenCalledTimes(8);

    vi.resetModules();
    actions = await import("./actions");
    h.auth.signInWithOtp.mockClear();
    for (let i = 0; i < 6; i++) {
      h.jar.clear(); // bypass the cooldown cookie to reach the per-email limit
      h.headers.set("x-forwarded-for", `198.51.100.${i}`); // a different IP each time
      last = await run(() => actions.requestCode(undefined, form({ email: "same@example.com" })));
    }
    expect(last?.state?.error?.en).toMatch(/Too many attempts/); // 6th request for one email
    expect(h.auth.signInWithOtp).toHaveBeenCalledTimes(5);
  });
});

describe("resendCode", () => {
  it("returns to sign-in when there is no pending email", async () => {
    expect((await run(() => actions.resendCode(undefined, form({ event: "tamilil-sollu" })))).redirect).toBe("/signin?event=tamilil-sollu");
    expect(h.auth.signInWithOtp).not.toHaveBeenCalled();
  });

  it("refuses during the cooldown and sends after it, using the email from the cookie", async () => {
    seedPending("a@example.com", 10_000);
    const early = await run(() => actions.resendCode(undefined, form({})));
    expect(early.state?.error?.en).toMatch(/Wait \d+ seconds/);
    expect(h.auth.signInWithOtp).not.toHaveBeenCalled();

    seedPending("a@example.com", 61_000);
    const late = await run(() => actions.resendCode(undefined, form({ event: "kutti-pesalar" })));
    expect(h.auth.signInWithOtp).toHaveBeenCalledExactlyOnceWith({ email: "a@example.com", options: { shouldCreateUser: true } });
    expect(late.redirect).toBe("/signin/verify?event=kutti-pesalar&resent=1");
    expect(Date.now() - pendingCookie()!.sentAt).toBeLessThan(5_000); // cooldown restarted
  });
});

describe("verifyCode", () => {
  it("returns to sign-in when there is no pending email (expired or missing cookie)", async () => {
    expect((await run(() => actions.verifyCode(undefined, form({ code: "123456", event: "kutti-pesalar" })))).redirect).toBe("/signin?event=kutti-pesalar");
    expect(h.auth.verifyOtp).not.toHaveBeenCalled();
  });

  it("rejects a code that is not six digits without contacting Supabase (default length)", async () => {
    seedPending("a@example.com", 5_000);
    for (const bad of ["", "12345", "abcdef", "1234567"]) {
      const { state } = await run(() => actions.verifyCode(undefined, form({ code: bad })));
      expect(state?.fieldError?.en, bad).toBe("Enter the 6-digit code.");
    }
    expect(h.auth.verifyOtp).not.toHaveBeenCalled();
  });

  describe("with RIO_OTP_LENGTH=8 (the dev project)", () => {
    beforeEach(() => {
      vi.stubEnv("RIO_OTP_LENGTH", "8");
      seedPending("a@example.com", 5_000);
    });
    afterEach(() => vi.unstubAllEnvs());

    it("accepts exactly eight digits, keeps a leading zero, and passes the code to Supabase unchanged as an email OTP", async () => {
      const { redirect } = await run(() => actions.verifyCode(undefined, form({ code: "0483 9201", event: "kutti-pesalar" })));
      expect(h.auth.verifyOtp).toHaveBeenCalledExactlyOnceWith({ email: "a@example.com", token: "04839201", type: "email" });
      expect(redirect).toBe("/events/kutti-pesalar/register");
    });

    it("refuses six digits and nine digits with a message that names eight, in Tamil and English, without contacting Supabase", async () => {
      for (const bad of ["048392", "048392011", "", "0483920a", "٠٤٨٣٩٢٠١"]) {
        const { state } = await run(() => actions.verifyCode(undefined, form({ code: bad })));
        expect(state?.fieldError?.en, bad).toBe("Enter the 8-digit code.");
        expect(state?.fieldError?.ta, bad).toContain("8 இலக்க");
      }
      expect(h.auth.verifyOtp).not.toHaveBeenCalled();
    });

    it("still reports an incorrect eight-digit code as wrong or expired, from Supabase", async () => {
      h.auth.verifyOtp.mockResolvedValue({ data: { session: null }, error: { code: "otp_expired", status: 403, message: "x" } });
      const { state, redirect } = await run(() => actions.verifyCode(undefined, form({ code: "00000000" })));
      expect(redirect).toBeUndefined();
      expect(state?.error?.en).toMatch(/wrong or has expired/i);
      expect(h.auth.verifyOtp).toHaveBeenCalledTimes(1);
    });
  });

  it("works for every supported length and refuses a length that is not configured", async () => {
    for (let n = 6; n <= 10; n++) {
      vi.stubEnv("RIO_OTP_LENGTH", String(n));
      seedPending("a@example.com", 5_000);
      h.auth.verifyOtp.mockClear();
      const good = "0123456789".slice(0, n);
      await run(() => actions.verifyCode(undefined, form({ code: good })));
      expect(h.auth.verifyOtp, String(n)).toHaveBeenCalledExactlyOnceWith({ email: "a@example.com", token: good, type: "email" });
      h.auth.verifyOtp.mockClear();
      seedPending("a@example.com", 5_000); // a successful sign-in clears the pending cookie
      const { state } = await run(() => actions.verifyCode(undefined, form({ code: good + "1" })));
      expect(state?.fieldError?.en, String(n)).toBe(`Enter the ${n}-digit code.`);
      expect(h.auth.verifyOtp, String(n)).not.toHaveBeenCalled();
    }
    vi.unstubAllEnvs();
  });

  it("fails closed when the configured length is invalid: 'unavailable', and Supabase is never asked", async () => {
    seedPending("a@example.com", 5_000);
    for (const bad of ["5", "11", "abc"]) {
      vi.stubEnv("RIO_OTP_LENGTH", bad);
      const { state, redirect } = await run(() => actions.verifyCode(undefined, form({ code: "123456" })));
      expect(redirect, bad).toBeUndefined();
      expect(state?.error?.en, bad).toMatch(/unavailable/i);
    }
    expect(h.auth.verifyOtp).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("shows one clear message for a wrong or expired code and keeps the parent on the page", async () => {
    seedPending("a@example.com", 5_000);
    h.auth.verifyOtp.mockResolvedValue({ data: { session: null }, error: { code: "otp_expired", status: 403, message: "Token has expired or is invalid" } });
    const { state, redirect } = await run(() => actions.verifyCode(undefined, form({ code: "000000" })));
    expect(redirect).toBeUndefined();
    expect(state?.error?.en).toMatch(/wrong or has expired/i);
    expect(h.auth.verifyOtp).toHaveBeenCalledExactlyOnceWith({ email: "a@example.com", token: "000000", type: "email" });
    expect(pendingCookie()).not.toBeNull(); // still can try again or resend
  });

  it("limits guesses: after 8 attempts Supabase is no longer asked", async () => {
    seedPending("a@example.com", 5_000);
    h.auth.verifyOtp.mockResolvedValue({ data: { session: null }, error: { code: "otp_expired", status: 403, message: "x" } });
    let last;
    for (let i = 0; i < 9; i++) last = await run(() => actions.verifyCode(undefined, form({ code: "111111" })));
    expect(last?.state?.error?.en).toMatch(/Too many attempts/);
    expect(h.auth.verifyOtp).toHaveBeenCalledTimes(8);
  });

  it("accepts a code typed with a space, signs in, clears the pending cookie and goes to the selected competition", async () => {
    seedPending("a@example.com", 5_000);
    const { redirect } = await run(() => actions.verifyCode(undefined, form({ code: "123 456", event: "kutti-pesalar" })));
    expect(h.auth.verifyOtp).toHaveBeenCalledExactlyOnceWith({ email: "a@example.com", token: "123456", type: "email" });
    expect(redirect).toBe("/events/kutti-pesalar/register");
    expect(pendingCookie()).toBeNull();
    expect(h.jar.get("rio_otp")?.options.maxAge).toBe(0);
  });

  it("goes to the account page when no (or an invalid) competition was selected", async () => {
    for (const event of [undefined, "https://evil.example", "//evil.example"]) {
      seedPending("a@example.com", 5_000);
      const { redirect } = await run(() => actions.verifyCode(undefined, form(event ? { code: "123456", event } : { code: "123456" })));
      expect(redirect, String(event)).toBe("/account");
    }
  });

  it("does not sign in when Supabase returns no session", async () => {
    seedPending("a@example.com", 5_000);
    h.auth.verifyOtp.mockResolvedValue({ data: { session: null }, error: null });
    const { state, redirect } = await run(() => actions.verifyCode(undefined, form({ code: "123456" })));
    expect(redirect).toBeUndefined();
    expect(state?.error?.en).toMatch(/could not sign you in/i);
  });

  it("reports 'unavailable' when the project is not configured", async () => {
    seedPending("a@example.com", 5_000);
    h.broken.config = true;
    expect((await run(() => actions.verifyCode(undefined, form({ code: "123456" })))).state?.error?.en).toMatch(/unavailable/i);
  });
});

describe("signOut", () => {
  it("signs out this browser only and returns to the home page, even if Supabase is unavailable", async () => {
    expect((await run(() => actions.signOut())).redirect).toBe("/");
    expect(h.auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
    h.broken.config = true;
    expect((await run(() => actions.signOut())).redirect).toBe("/");
  });
});

describe("privacy", () => {
  it("never logs an email address or a code, and never returns them from verification", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await run(() => actions.requestCode(undefined, form({ email: "private.person@example.com", event: "kutti-pesalar" })));
    h.auth.verifyOtp.mockResolvedValueOnce({ data: { session: null }, error: { code: "otp_expired", status: 403, message: "private.person@example.com 654321" } });
    const wrong = await run(() => actions.verifyCode(undefined, form({ code: "654321" })));
    await run(() => actions.verifyCode(undefined, form({ code: "654321" })));
    await run(() => actions.signOut());
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(wrong.state)).not.toMatch(/private\.person|654321/);
    vi.restoreAllMocks();
  });
});
