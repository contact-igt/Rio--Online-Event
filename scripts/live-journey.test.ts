import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeMp4, remuxFragmentedMp4 } from "../e2e-live/mp4";
import { inspectVideo } from "../lib/submit/inspect";
import { assertJourneyTarget, CLEANUP_ORDER, JourneyGuardError, playbackLinkProblems, preflightProblems, tamperedLinks, type Baseline } from "./live-journey";

const REF = "abcdefghijklmnopqrst";
const good = {
  R2_BUCKET_NAME: "rio-childrens-day-dev",
  RIO_LIVE_R2_CONFIRM: "rio-childrens-day-dev",
  RIO_DEV_PROJECT_REF: REF,
  RIO_LIVE_CONFIRM: REF,
  RIO_LIVE_JOURNEY_CONFIRM: REF,
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "x".repeat(32),
  R2_SECRET_ACCESS_KEY: "y".repeat(64),
  SUPABASE_SECRET_KEY: "sb_secret_x",
  RIO_LIVE_URL: "https://example.test",
  RIO_LIVE_SECRET_KEY: "sb_secret_y",
};

describe("assertJourneyTarget: one run needs three typed confirmations and every switch off", () => {
  it("accepts the dev project and dev bucket with all confirmations", () => {
    expect(assertJourneyTarget(good)).toEqual({ bucket: "rio-childrens-day-dev", devRef: REF });
  });
  it("refuses each missing or wrong confirmation", () => {
    for (const [name, value] of [["RIO_LIVE_R2_CONFIRM", "other"], ["RIO_LIVE_R2_CONFIRM", undefined], ["RIO_LIVE_CONFIRM", undefined], ["RIO_LIVE_CONFIRM", "zzzzzzzzzzzzzzzzzzzz"], ["RIO_LIVE_JOURNEY_CONFIRM", undefined], ["RIO_LIVE_JOURNEY_CONFIRM", "yes"], ["RIO_DEV_PROJECT_REF", "short"]] as const) {
      expect(() => assertJourneyTarget({ ...good, [name]: value }), `${name}=${String(value)}`).toThrow(JourneyGuardError);
    }
  });
  it("refuses a production-looking or unnamed bucket", () => {
    for (const bucket of ["rio-childrens-day-prod", "rio-live-videos", "rio-videos", "x"]) {
      expect(() => assertJourneyTarget({ ...good, R2_BUCKET_NAME: bucket, RIO_LIVE_R2_CONFIRM: bucket }), bucket).toThrow(JourneyGuardError);
    }
  });
  it("refuses to start when any feature switch is already on in the test process, or a push confirmation is set", () => {
    for (const name of ["RIO_UPLOADS_ENABLED", "RIO_FINALIZE_ENABLED", "RIO_PLAYBACK_ENABLED"]) expect(() => assertJourneyTarget({ ...good, [name]: "yes" }), name).toThrow(JourneyGuardError);
    expect(() => assertJourneyTarget({ ...good, RIO_CONFIRM_PUSH: REF })).toThrow(JourneyGuardError);
    expect(() => assertJourneyTarget({ ...good, RIO_PLAYBACK_ENABLED: "no", RIO_FINALIZE_ENABLED: "" })).not.toThrow();
  });
  it("its messages never contain a value", () => {
    try {
      assertJourneyTarget({ ...good, R2_SECRET_ACCESS_KEY: "", RIO_LIVE_JOURNEY_CONFIRM: "secret-typo-value" });
    } catch (e) {
      expect((e as Error).message).not.toMatch(/secret-typo-value|yyyy|abcdefghij/);
    }
  });
});

describe("preflightProblems: the run only starts from the expected empty DEV state", () => {
  const empty: Baseline = { counts: { submissions: 0, video_uploads: 0, judge_assignments: 0, scores: 0, winners: 0, judge_profiles: 0 }, settings: { submissions_open_at: null, submissions_close_at: null, current_consent_version: null, results_publish_at: null }, bucketKeys: 0, events: 6 };
  it("passes on the empty baseline", () => expect(preflightProblems(empty)).toEqual([]));
  it("names every deviation, and nothing else", () => {
    expect(preflightProblems({ ...empty, counts: { ...empty.counts, submissions: 1, winners: 2 } })).toEqual(["submissions is not empty", "winners is not empty"]);
    expect(preflightProblems({ ...empty, settings: { ...empty.settings, submissions_open_at: "2026-01-01" } })).toEqual(["registration is not closed"]);
    expect(preflightProblems({ ...empty, settings: { ...empty.settings, results_publish_at: "2099-01-01" } })).toEqual(["results are scheduled for publication"]);
    expect(preflightProblems({ ...empty, bucketKeys: 3, events: 5 })).toEqual(["the bucket is not empty", "the six events are not all present"]);
  });
});

describe("playbackLinkProblems and tamperedLinks", () => {
  const host = "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com";
  const video = "videos/cccccccc-0000-4000-8000-0000000000c1";
  const link = `https://${host}/rio-childrens-day-dev/${video}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=300&X-Amz-Signature=0abc`;
  const opts = { host, videoKey: video, maxSeconds: 300 };
  it("accepts a five-minute link for the right host and object", () => expect(playbackLinkProblems(link, opts)).toEqual([]));
  it("names what is wrong, without echoing the link", () => {
    expect(playbackLinkProblems(link.replace("X-Amz-Expires=300", "X-Amz-Expires=3600"), opts)).toEqual(["lives longer than allowed"]);
    expect(playbackLinkProblems(link.replace(host, "evil.example"), opts)).toEqual(["not the bucket host"]);
    expect(playbackLinkProblems(link.replace("cccccccc", "dddddddd"), opts)).toEqual(["not the expected object"]);
    expect(playbackLinkProblems(link.replace("&X-Amz-Signature=0abc", ""), opts)).toEqual(["not signed"]);
    expect(playbackLinkProblems(link.replace("https:", "http:"), opts)).toContain("not https");
    expect(playbackLinkProblems("nope", opts)).toEqual(["not a URL"]);
  });
  it("builds a bad-signature link and an unsigned link that differ from the real one", () => {
    const t = tamperedLinks(link);
    expect(t.badSignature).not.toBe(link);
    expect(new URL(t.badSignature).searchParams.get("X-Amz-Signature")).not.toBe("0abc");
    expect(t.unsigned).toBe(`https://${host}/rio-childrens-day-dev/${video}`);
  });
});

describe("cleanup order", () => {
  it("deletes children before parents, never touches the audit log, and restores settings last", () => {
    const o = [...CLEANUP_ORDER];
    expect(o).not.toContain("audit_log" as never);
    expect(o.indexOf("winners")).toBeLessThan(o.indexOf("submissions"));
    expect(o.indexOf("scores")).toBeLessThan(o.indexOf("judge_profiles"));
    expect(o.indexOf("judge_assignments")).toBeLessThan(o.indexOf("submissions"));
    expect(o.indexOf("judge_profiles")).toBeLessThan(o.indexOf("user_roles"));
    expect(o.indexOf("user_roles")).toBeLessThan(o.indexOf("auth_users"));
    expect(o.at(-1)).toBe("event_settings");
  });
});

describe("the MP4 fixture: a real Chrome-recorded fragmented file becomes an ordinary MP4 with the true duration", () => {
  const original = readFileSync(new URL("../e2e-live/fixtures/chrome-fragmented-4s.mp4", import.meta.url));
  const fixed = remuxFragmentedMp4(original);
  const mdatBytes = (b: Buffer) => {
    const out: Buffer[] = [];
    for (let at = 0; at + 8 <= b.length; ) {
      const size = b.readUInt32BE(at);
      if (b.toString("latin1", at + 4, at + 8) === "mdat") out.push(b.subarray(at + 8, at + size));
      at += size;
    }
    return Buffer.concat(out);
  };

  it("the sample is genuinely fragmented with a header duration of 0 (what the inspector must cope with)", () => {
    expect(describeMp4(original.length ? original : Buffer.alloc(0))).toMatchObject({ fragmented: true, seconds: 0 });
  });
  it("after conversion it is not fragmented, has the true duration and a full sample table", () => {
    const facts = describeMp4(fixed);
    expect(facts.fragmented).toBe(false);
    expect(facts.seconds).toBeGreaterThan(3.9);
    expect(facts.seconds).toBeLessThan(4.1);
    expect(facts.samples).toBeGreaterThan(60);
    expect(Math.abs(fixed.length - original.length)).toBeLessThan(original.length * 0.05);
  });
  it("the encoded samples are copied byte for byte", () => {
    expect(mdatBytes(fixed).equals(mdatBytes(original))).toBe(true);
  });
  it("the real inspector reads the true duration from the converted file (4 s is outside 30 to 90, so it says so)", async () => {
    const read = (b: Buffer) => async (start: number, end: number) => new Uint8Array(b.subarray(start, end + 1));
    expect(await inspectVideo("video/mp4", fixed.length, read(fixed))).toEqual({ ok: false, reason: "tooShort" });
    // the original fragmented file is accepted as "length unknown", not refused as empty
    expect(await inspectVideo("video/mp4", original.length, read(original))).toEqual({ ok: true, container: "mp4", durationSeconds: null });
  });
  it("refuses garbage instead of producing a file", () => {
    expect(() => remuxFragmentedMp4(Buffer.from("not an mp4 at all, just text"))).toThrow();
    expect(() => remuxFragmentedMp4(fixed)).toThrow(); // already progressive: nothing to convert
  });
});
