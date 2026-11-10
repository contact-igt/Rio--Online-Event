import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertUploadTarget, authHealth, isTrackedKey, isUploadId, keysFor, leaksSensitive, mediaProblems, planCleanup, stage, timeoutFetch, UploadGuardError, withTimeout } from "./live-upload.ts";

const ID = "3f2b8c1e-9a4d-4e57-8a0b-5c6d7e8f9a0b";
const OTHER = "11111111-2222-4333-8444-555555555555";
const good = {
  R2_BUCKET_NAME: "rio-test-dev-bucket",
  RIO_LIVE_R2_CONFIRM: "rio-test-dev-bucket",
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "a".repeat(32),
  R2_SECRET_ACCESS_KEY: "b".repeat(64),
  SUPABASE_SECRET_KEY: "sb_secret_x",
  RIO_LIVE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  RIO_LIVE_SECRET_KEY: "sb_secret_y",
};
const refusal = (env: Record<string, string | undefined>) => {
  try {
    assertUploadTarget(env);
  } catch (e) {
    expect(e).toBeInstanceOf(UploadGuardError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("assertUploadTarget", () => {
  it("accepts a dev-looking bucket whose name was typed back as the confirmation", () => {
    expect(assertUploadTarget(good)).toEqual({ bucket: "rio-test-dev-bucket" });
  });

  it("refuses without the typed bucket confirmation, or with a different one", () => {
    expect(refusal({ ...good, RIO_LIVE_R2_CONFIRM: undefined })).toMatch(/RIO_LIVE_R2_CONFIRM/);
    expect(refusal({ ...good, RIO_LIVE_R2_CONFIRM: "another-dev-bucket" })).toMatch(/RIO_LIVE_R2_CONFIRM/);
    expect(refusal({ ...good, RIO_LIVE_R2_CONFIRM: "yes" })).toMatch(/RIO_LIVE_R2_CONFIRM/);
  });

  it("refuses a production-looking or unmarked bucket even when it is confirmed", () => {
    for (const name of ["rio-childrens-day-prod", "rio-live-videos", "rio-childrens-day", "videos"]) {
      expect(() => assertUploadTarget({ ...good, R2_BUCKET_NAME: name, RIO_LIVE_R2_CONFIRM: name }), name).toThrow(UploadGuardError);
    }
    expect(assertUploadTarget({ ...good, R2_BUCKET_NAME: "rio-childrens-day-dev", RIO_LIVE_R2_CONFIRM: "rio-childrens-day-dev" }).bucket).toBe("rio-childrens-day-dev");
  });

  it("refuses when uploads are already switched on in the test process, or a setting is missing", () => {
    expect(refusal({ ...good, RIO_UPLOADS_ENABLED: "yes" })).toMatch(/must not be on/);
    for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "SUPABASE_SECRET_KEY", "RIO_LIVE_URL", "RIO_LIVE_SECRET_KEY"]) {
      expect(() => assertUploadTarget({ ...good, [name]: "" }), name).toThrow(UploadGuardError);
    }
    expect(() => assertUploadTarget({})).toThrow(UploadGuardError);
  });

  it("its messages are fixed strings that never contain a setting's value", () => {
    for (const env of [{ ...good, RIO_LIVE_R2_CONFIRM: "nope" }, { ...good, R2_BUCKET_NAME: "BAD NAME", RIO_LIVE_R2_CONFIRM: "BAD NAME" }, { ...good, RIO_UPLOADS_ENABLED: "yes" }, { ...good, R2_ACCESS_KEY_ID: "" }]) {
      const m = refusal(env);
      for (const v of Object.values(good)) expect(m.includes(v), m).toBe(false);
    }
  });
});

describe("object keys and the cleanup plan", () => {
  const tracked = new Set([ID]);

  it("an upload id has exactly two possible keys, built only from the id", () => {
    expect(keysFor(ID)).toEqual([`pending/${ID}`, `videos/${ID}`]);
    expect(isUploadId(ID)).toBe(true);
    for (const bad of ["", "pending/x", `${ID}/..`, ID.toUpperCase(), 5, null, undefined]) expect(isUploadId(bad), String(bad)).toBe(false);
  });

  it("only pending/<id> and videos/<id> of a tracked id count as ours", () => {
    expect(isTrackedKey(`pending/${ID}`, tracked)).toBe(true);
    expect(isTrackedKey(`videos/${ID}`, tracked)).toBe(true);
    for (const key of [`pending/${OTHER}`, `videos/${OTHER}`, `other/${ID}`, `pending/${ID}/x`, `pending/${ID}.mp4`, `/pending/${ID}`, `pending/../videos/${ID}`, "pending/", "", ID]) {
      expect(isTrackedKey(key, tracked), key).toBe(false);
    }
  });

  it("deletes exactly the tracked keys that appeared during the run", () => {
    const plan = planCleanup({ tracked, before: [], after: [`videos/${ID}`, `pending/${ID}`] });
    expect(plan).toEqual({ remove: [`pending/${ID}`, `videos/${ID}`], unexpected: 0, preExisting: 0 });
  });

  it("never deletes an object that was already in the bucket, even if its name looks like ours", () => {
    const plan = planCleanup({ tracked, before: [`videos/${ID}`, `videos/${OTHER}`], after: [`videos/${ID}`, `videos/${OTHER}`, `pending/${ID}`] });
    expect(plan.remove).toEqual([`pending/${ID}`]);
    expect(plan.preExisting).toBe(2);
  });

  it("reports untracked new objects by count and never deletes them", () => {
    const plan = planCleanup({ tracked, before: ["videos/keep-me"], after: ["videos/keep-me", `pending/${OTHER}`, "videos/someone-elses.mp4", `pending/${ID}`] });
    expect(plan.remove).toEqual([`pending/${ID}`]);
    expect(plan.unexpected).toBe(2);
    expect(plan.remove.every((k) => isTrackedKey(k, tracked))).toBe(true);
  });

  it("with nothing tracked, nothing is ever deleted", () => {
    const plan = planCleanup({ tracked: new Set(), before: [], after: [`pending/${ID}`, `videos/${OTHER}`, "x"] });
    expect(plan.remove).toEqual([]);
    expect(plan.unexpected).toBe(3);
  });
});

describe("mediaProblems (the generated test video must be real before anything hosted is touched)", () => {
  const good = { bytes: 900_000, duration: 31.1, width: 320, height: 240, played: true, mime: "video/webm;codecs=vp8" };

  it("accepts a decodable, playable WebM of about the expected length", () => {
    expect(mediaProblems(good, 31)).toEqual([]);
    expect(mediaProblems({ ...good, duration: 30.6 }, 31)).toEqual([]);
    expect(mediaProblems({ ...good, duration: 32.4 }, 31)).toEqual([]);
  });

  it("names every way it can be wrong", () => {
    expect(mediaProblems({ ...good, duration: 20 }, 31)).toEqual(["duration is not the expected length"]);
    expect(mediaProblems({ ...good, duration: 60 }, 31)).toEqual(["duration is not the expected length"]);
    expect(mediaProblems({ ...good, duration: Number.POSITIVE_INFINITY }, 31)).toEqual(["duration unreadable"]);
    expect(mediaProblems({ ...good, bytes: 50_000 }, 31)).toEqual(["smaller than the 100 KB minimum"]);
    expect(mediaProblems({ ...good, bytes: 101 * 1024 * 1024 }, 31)).toEqual(["larger than the 100 MB maximum"]);
    expect(mediaProblems({ ...good, width: 0, height: 0 }, 31)).toEqual(["no picture"]);
    expect(mediaProblems({ ...good, played: false }, 31)).toEqual(["did not play"]);
    expect(mediaProblems({ ...good, mime: "audio/wav" }, 31)).toEqual(["not a WebM recording"]);
  });
});

describe("provisioning is bounded and fails fast with a named stage", () => {
  const never = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch; // a request that never answers (a stalled network)

  it("timeoutFetch aborts a request that never answers, and passes a normal one through", async () => {
    const stalled = ((_: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "TimeoutError" }))))) as unknown as typeof fetch;
    const started = Date.now();
    await expect(timeoutFetch(50, stalled)("https://x.test")).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(2000);
    const ok = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    expect((await timeoutFetch(50, ok)("https://x.test")).status).toBe(200);
  });

  it("timeoutFetch still honours a signal the caller already passed", async () => {
    const stalled = ((_: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    const controller = new AbortController();
    const pending = timeoutFetch(60_000, stalled)("https://x.test", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
  });

  it("authHealth answers with a fixed verdict only: healthy, unhealthy or unreachable", async () => {
    const answer = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;
    expect(await authHealth("https://p.supabase.co/", "key", answer(200))).toBe("healthy");
    expect(await authHealth("https://p.supabase.co", "key", answer(503))).toBe("unhealthy");
    expect(await authHealth("https://p.supabase.co", "key", (async () => { throw new Error("getaddrinfo ENOTFOUND p.supabase.co"); }) as unknown as typeof fetch)).toBe("unreachable");
    const stalled = ((_: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "TimeoutError" }))))) as unknown as typeof fetch;
    expect(await authHealth("https://p.supabase.co", "key", timeoutFetch(30, stalled))).toBe("unreachable"); // a stall counts as unreachable (a real fetch honours the abort signal)
    const seen: string[] = [];
    await authHealth("https://p.supabase.co/", "the-key", (async (url: unknown, init?: RequestInit) => (seen.push(String(url), JSON.stringify(init?.headers)), new Response("{}"))) as unknown as typeof fetch);
    expect(seen[0]).toBe("https://p.supabase.co/auth/v1/health"); // exactly one harmless GET of the public health endpoint
    expect(never).toBeTypeOf("function");
  });

  it("stage turns any failure into a short fixed message naming the stage, dropping the original text", async () => {
    await expect(stage("create parent A", async () => { throw Object.assign(new Error("fetch failed https://p.supabase.co/auth/v1/admin/users?key=secret"), { name: "TypeError" }); })).rejects.toThrow('provisioning failed at stage "create parent A" (TypeError)');
    try {
      await stage("x", async () => { throw new Error("https://p.supabase.co sb_secret_abc"); });
    } catch (e) {
      expect((e as Error).message).not.toMatch(/supabase|sb_secret|https/);
    }
    expect(await stage("fine", async () => 42)).toBe(42);
  });

  it("withTimeout rejects a call that never settles, and returns the value of one that does", async () => {
    await expect(withTimeout(new Promise<number>(() => undefined), 30)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(await withTimeout(Promise.resolve(7), 1000)).toBe(7);
  });
});

describe("leaksSensitive", () => {
  it("flags signed-URL parts, object paths, key material and known secrets, and passes plain messages", () => {
    expect(leaksSensitive("https://x.r2.cloudflarestorage.com/b/pending/abc?X-Amz-Signature=1", [])).toBe(true);
    expect(leaksSensitive("see videos/abc", [])).toBe(true);
    expect(leaksSensitive("sb_secret_abcdef", [])).toBe(true);
    expect(leaksSensitive("the account is hunter22secret", ["hunter22secret"])).toBe(true);
    expect(leaksSensitive("We could not find this entry. Refresh the page and try again.", ["hunter22secret"])).toBe(false);
    expect(leaksSensitive('{"ok":false,"code":"notFound"}', ["hunter22secret"])).toBe(false);
  });
});

describe("the live upload files are wired so they cannot run by accident", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("the registration live config never picks up the upload test, and the upload config picks up only it", () => {
    expect(read("e2e-live/playwright.live.config.ts")).toContain(`testMatch: "*.live.spec.ts"`);
    const upload = read("e2e-live/playwright.upload.config.ts");
    expect(upload).toContain(`testMatch: "*.liveupload.ts"`);
    expect("upload.liveupload.ts".endsWith(".live.spec.ts")).toBe(false);
  });

  it("the upload config checks the guard before building anything, never reuses a server, and records nothing that could hold a secret", () => {
    const cfg = read("e2e-live/playwright.upload.config.ts");
    expect(cfg.indexOf("assertUploadTarget(")).toBeGreaterThan(-1);
    expect(cfg.indexOf("assertUploadTarget(")).toBeLessThan(cfg.indexOf("webServer"));
    expect(cfg).toContain("reuseExistingServer: false");
    expect(cfg).toContain(`RIO_UPLOADS_ENABLED: "yes"`); // only in the server's own environment
    expect(cfg).toContain("RIO_DIST_DIR");
    for (const off of [`trace: "off"`, `screenshot: "off"`, `video: "off"`]) expect(cfg).toContain(off);
    expect(cfg).toContain(`reporter: "line"`);
    expect(cfg).toContain("workers: 1");
  });

  it("the registration live suite refuses to run while uploads are switched on", () => {
    expect(read("e2e-live/registration.live.spec.ts")).toMatch(/RIO_UPLOADS_ENABLED === "yes"/);
  });

  it("the upload test never logs, only deletes keys the plan produced, and cleans up in afterAll", () => {
    const spec = read("e2e-live/upload.liveupload.ts");
    expect(spec).not.toMatch(/console\.(log|info|warn|error|debug)/);
    expect(spec).toContain("test.afterAll");
    expect(spec).toContain("planCleanup(");
    const removals = [...spec.matchAll(/\.remove\(([^)]*)\)/g)].map((m) => m[1]!).filter((arg) => arg !== "...a"); // "...a" is the counting pass-through
    expect(removals).toEqual(["key"]); // the single deletion in the whole file is of a key taken from the cleanup plan
    expect(spec.indexOf("if (!isTrackedKey(key, tracked)) continue;")).toBeLessThan(spec.indexOf("real.remove(key)"));
    expect(spec).toContain("isTrackedKey(");
  });

  it("the live suites bound every Supabase request, and the upload hook is staged, fail-fast and generous", () => {
    const helpers = read("e2e-live/helpers.ts");
    expect(helpers.match(/fetch: timeoutFetch\(REQUEST_TIMEOUT_MS\)/g)?.length).toBe(2); // the secret-key client and the user-session client
    const spec = read("e2e-live/upload.liveupload.ts");
    const hook = spec.slice(spec.indexOf("test.beforeAll("), spec.indexOf("test.afterAll("));
    expect(hook).toContain("test.setTimeout(360_000)");
    expect(hook).toContain(`if (health !== "healthy") throw new Error(`); // an unhealthy answer stops the run before any write
    expect(hook.indexOf("generateWebm(")).toBeLessThan(hook.indexOf("authHealth("));
    expect(hook.indexOf("authHealth(")).toBeLessThan(hook.indexOf("createDummyUser(")); // the health check comes before the first write
    expect(hook.indexOf("authHealth(")).toBeLessThan(hook.indexOf("event_settings"));
    for (const name of ["create parent A", "create parent B", "open the temporary registration window", "start parent A", "start parent B", "list the bucket baseline"]) expect(hook, name).toContain(name);
    expect(spec).toContain("abortSignal: AbortSignal.timeout(30_000)");
    expect(spec).toContain("withTimeout(real.remove(key)");
  });

  it("the video generator warms the encoder up before the real recording, with a bounded wait and a clear failure", () => {
    const media = read("e2e-live/media.ts");
    expect(media.indexOf("warm.start(")).toBeGreaterThan(-1);
    expect(media.indexOf("warm.start(")).toBeLessThan(media.indexOf("recorder.start("));
    expect(media).toContain("30_000"); // the warm-up wait is bounded
    expect(media).toContain("is the machine too busy?");
    expect(media).not.toMatch(/console\./);
  });

  it("every R2 request the app can make is scoped to the single configured bucket", () => {
    const store = readFileSync(join(process.cwd(), "lib/storage/object-store.ts"), "utf8");
    const bucketUses = [...store.matchAll(/Bucket[:,]?\s*[:=]?\s*([A-Za-z.]+)/g)].map((m) => m[1]);
    expect(store).toContain("const Bucket = cfg.bucket;");
    expect(store).not.toMatch(/Bucket:\s*["'`]/); // no hard-coded bucket anywhere
    expect(bucketUses.length).toBeGreaterThan(0);
  });

  it("the upload run goes through a wrapper that restores tsconfig.json and next-env.d.ts and removes the extra build directory, however the run ends", () => {
    const w = read("scripts/live-upload-run.mjs");
    expect(w).toContain("tsconfig.json");
    expect(w).toContain("next-env.d.ts");
    expect(w).toContain(".next-upload-test");
    expect(w.indexOf("readFileSync")).toBeLessThan(w.indexOf("spawn(")); // saved before the run starts
    expect(w).toMatch(/child\.on\("exit"[\s\S]*restore\(\)/);
    expect(w).toMatch(/child\.on\("error"[\s\S]*restore\(\)/);
    expect(w).not.toMatch(/console\./);
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:e2e:live:upload"]).toContain("scripts/live-upload-run.mjs");
  });

  it("the standard live script never starts the upload config, and the upload script needs both confirmations", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:e2e:live"]).not.toContain("playwright.upload.config");
    expect(pkg.scripts["test:e2e:live:upload"]).toContain("scripts/live-upload-run.mjs"); // which runs playwright.upload.config.ts
    expect(read("scripts/live-upload-run.mjs")).toContain("e2e-live/playwright.upload.config.ts");
    expect(pkg.scripts["test:e2e:live:upload"]).toContain("check-live");
  });
});
