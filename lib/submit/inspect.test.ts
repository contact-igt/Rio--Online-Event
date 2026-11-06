import { describe, expect, it } from "vitest";
import { inspectVideo, type RangeReader } from "./inspect";

// Synthetic containers built byte by byte. They prove the parser's behaviour on well-formed and malformed headers; they do NOT
// prove anything about real phone recordings (UNVERIFIED until tried on real files of each accepted type).

const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const text = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const be = (n: number, len: number) => Uint8Array.from({ length: len }, (_, i) => Math.floor(n / 256 ** (len - 1 - i)) % 256);

// --- MP4 / MOV ---
const box = (type: string, ...body: Uint8Array[]) => {
  const payload = cat(...body);
  return cat(be(8 + payload.length, 4), text(type), payload);
};
const mvhd = (seconds: number, timescale = 1000, version = 0) =>
  version === 0
    ? box("mvhd", Uint8Array.of(0, 0, 0, 0), be(0, 4), be(0, 4), be(timescale, 4), be(seconds * timescale, 4), new Uint8Array(80))
    : box("mvhd", Uint8Array.of(1, 0, 0, 0), be(0, 8), be(0, 8), be(timescale, 4), be(seconds * timescale, 8), new Uint8Array(80));
const trak = (handler = "vide") => box("trak", box("mdia", box("hdlr", new Uint8Array(8), text(handler), new Uint8Array(12))));
const mp4 = (seconds: number, opts: { moovAtEnd?: boolean; brand?: string; handler?: string; version?: number; padMdat?: number } = {}) => {
  const ftyp = box("ftyp", text(opts.brand ?? "isom"), be(0, 4), text("isom"));
  const moov = box("moov", mvhd(seconds, 1000, opts.version ?? 0), trak(opts.handler));
  const mdat = box("mdat", new Uint8Array(opts.padMdat ?? 2000));
  return opts.moovAtEnd ? cat(ftyp, mdat, moov) : cat(ftyp, moov, mdat);
};

// --- WebM ---
const el = (id: number, ...body: Uint8Array[]) => {
  const payload = cat(...body);
  const idBytes = be(id, id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1);
  return cat(idBytes, Uint8Array.of(0x10, 0, 0, 0).map((v, i) => (i === 0 ? 0x10 | ((payload.length >> 24) & 0x0f) : (payload.length >> (8 * (3 - i))) & 0xff)), payload);
};
const f64 = (n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, n);
  return b;
};
const webm = (opts: { seconds?: number; docType?: string; video?: boolean } = {}) => {
  const ebml = el(0x1a45dfa3, el(0x4282, text(opts.docType ?? "webm")));
  const info = el(0x1549a966, el(0x2ad7b1, be(1_000_000, 3)), ...(opts.seconds === undefined ? [] : [el(0x4489, f64(opts.seconds * 1000))]));
  const tracks = el(0x1654ae6b, el(0xae, el(0x83, Uint8Array.of(opts.video === false ? 2 : 1))));
  const cluster = el(0x1f43b675, el(0xe7, Uint8Array.of(0)));
  return cat(ebml, el(0x18538067, info, tracks, cluster));
};

const reader = (bytes: Uint8Array): { read: RangeReader; reads: number[][] } => {
  const reads: number[][] = [];
  return {
    reads,
    read: async (start, end) => {
      reads.push([start, end]);
      return bytes.subarray(start, Math.min(end + 1, bytes.length));
    },
  };
};
const run = (type: string, bytes: Uint8Array) => {
  const r = reader(bytes);
  return inspectVideo(type, bytes.length, r.read).then((res) => ({ res, reads: r.reads }));
};

describe("MP4 and MOV", () => {
  it("accepts a clip whose index (moov) is at the start and reads its declared duration", async () => {
    expect((await run("video/mp4", mp4(45))).res).toEqual({ ok: true, container: "mp4", durationSeconds: 45 });
  });
  it("finds the index when it is at the END of the file, with only a few small reads", async () => {
    const { res, reads } = await run("video/mp4", mp4(60, { moovAtEnd: true, padMdat: 5_000_000 }));
    expect(res).toEqual({ ok: true, container: "mp4", durationSeconds: 60 });
    expect(reads.length).toBeLessThanOrEqual(6);
    expect(reads.every(([a, b]) => b - a < 1024 * 1024)).toBe(true); // nothing like a whole-file read
  });
  it("reads a 64-bit (version 1) movie header and a QuickTime brand", async () => {
    expect((await run("video/quicktime", mp4(31, { version: 1, brand: "qt  " }))).res).toEqual({ ok: true, container: "mov", durationSeconds: 31 });
  });
  it("refuses a duration outside 30 to 90 seconds (one second of tolerance)", async () => {
    expect((await run("video/mp4", mp4(12))).res).toEqual({ ok: false, reason: "tooShort" });
    expect((await run("video/mp4", mp4(200))).res).toEqual({ ok: false, reason: "tooLong" });
    expect((await run("video/mp4", mp4(29.5))).res.ok).toBe(true);
    expect((await run("video/mp4", mp4(91))).res.ok).toBe(true);
    expect((await run("video/mp4", mp4(92))).res).toEqual({ ok: false, reason: "tooLong" });
  });
  it("refuses a file without a video track, a non-video file, and a WebM declared as MP4", async () => {
    expect((await run("video/mp4", mp4(45, { handler: "soun" }))).res).toEqual({ ok: false, reason: "notVideo" });
    expect((await run("video/mp4", text("<html><body>not a video at all, just text</body></html>"))).res).toEqual({ ok: false, reason: "notVideo" });
    expect((await run("video/mp4", webm({ seconds: 45 }))).res.ok).toBe(false);
  });
  it("refuses damaged boxes without throwing", async () => {
    const good = mp4(45);
    expect((await run("video/mp4", good.subarray(0, 40))).res.ok).toBe(false);
    const broken = good.slice();
    broken.set(be(3, 4), 0);
    expect((await run("video/mp4", broken)).res.ok).toBe(false);
    expect((await run("video/mp4", new Uint8Array(5))).res.ok).toBe(false);
  });
});

describe("WebM", () => {
  it("accepts a WebM with a video track and reads a declared duration", async () => {
    expect((await run("video/webm", webm({ seconds: 31 }))).res).toEqual({ ok: true, container: "webm", durationSeconds: 31 });
  });
  it("accepts a browser-recorded WebM that declares NO duration, and says the duration is unknown (not verified)", async () => {
    expect((await run("video/webm", webm())).res).toEqual({ ok: true, container: "webm", durationSeconds: null });
  });
  it("refuses a WebM with no video track, another DocType, a wrong duration, and MP4 bytes declared as WebM", async () => {
    expect((await run("video/webm", webm({ video: false, seconds: 40 }))).res).toEqual({ ok: false, reason: "notVideo" });
    expect((await run("video/webm", webm({ docType: "matroska", seconds: 40 }))).res).toEqual({ ok: false, reason: "typeMismatch" });
    expect((await run("video/webm", webm({ seconds: 5 }))).res).toEqual({ ok: false, reason: "tooShort" });
    expect((await run("video/webm", webm({ seconds: 300 }))).res).toEqual({ ok: false, reason: "tooLong" });
    expect((await run("video/webm", mp4(45))).res).toEqual({ ok: false, reason: "notVideo" });
  });
  it("copes with truncated and random bytes without throwing", async () => {
    const good = webm({ seconds: 40 });
    for (const n of [4, 9, 14, 20, 30]) expect((await run("video/webm", good.subarray(0, n))).res.ok, String(n)).toBe(false);
    const noise = Uint8Array.from({ length: 2000 }, (_, i) => (i * 2654435761) >>> 24);
    expect((await run("video/webm", noise)).res.ok).toBe(false);
  });
});

describe("limits and failures", () => {
  it("refuses an unsupported type or a tiny file without reading anything", async () => {
    expect((await run("text/plain", mp4(45))).res).toEqual({ ok: false, reason: "typeMismatch" });
    const r = reader(new Uint8Array(4));
    expect(await inspectVideo("video/mp4", 4, r.read)).toEqual({ ok: false, reason: "notVideo" });
    expect(r.reads).toEqual([]);
  });
  it("lets a bucket failure through (so the caller can say 'try again') instead of blaming the video", async () => {
    await expect(inspectVideo("video/mp4", 5000, async () => { throw new Error("R2 503"); })).rejects.toThrow("R2 503");
  });
});

describe("fragmented MP4 (what a browser's MediaRecorder writes)", () => {
  const fragmented = (opts: { mehdSeconds?: number } = {}) =>
    cat(
      box("ftyp", text("iso5"), be(0, 4), text("iso5")),
      box(
        "moov",
        box("mvhd", Uint8Array.of(1, 0, 0, 0), be(0, 8), be(0, 8), be(1000, 4), be(0, 8), new Uint8Array(80)), // header duration 0
        trak(),
        box("mvex", ...(opts.mehdSeconds === undefined ? [] : [box("mehd", Uint8Array.of(1, 0, 0, 0), be(opts.mehdSeconds * 1000, 8))]), box("trex", new Uint8Array(24))),
      ),
      box("moof", new Uint8Array(40)),
      box("mdat", new Uint8Array(150_000)),
    );

  it("a header duration of 0 with the fragment marker means the length is unknown, not 'too short'", async () => {
    expect((await run("video/mp4", fragmented())).res).toEqual({ ok: true, container: "mp4", durationSeconds: null });
  });
  it("uses the total declared by a mehd box when there is one, and still enforces the range", async () => {
    expect((await run("video/mp4", fragmented({ mehdSeconds: 45 }))).res).toEqual({ ok: true, container: "mp4", durationSeconds: 45 });
    expect((await run("video/mp4", fragmented({ mehdSeconds: 5 }))).res).toEqual({ ok: false, reason: "tooShort" });
    expect((await run("video/mp4", fragmented({ mehdSeconds: 400 }))).res).toEqual({ ok: false, reason: "tooLong" });
  });
  it("a header duration of 0 WITHOUT the fragment marker is an empty clip and is refused", async () => {
    expect((await run("video/mp4", mp4(0))).res).toEqual({ ok: false, reason: "tooShort" });
  });
});
