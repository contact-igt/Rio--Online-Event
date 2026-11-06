import { MAX_SECONDS, MIN_SECONDS } from "@/lib/upload/rules";

// Bounded server-side look at a stored video: is it really an MP4/MOV/WebM container with a video track, and what duration does
// its HEADER declare? It reads at most a few small byte ranges (never the whole file, no decoding, no transcoding), so it fits a
// serverless request and a private bucket.
//
// WHAT THIS PROVES: the file starts like the container its type claims, has a video track, and (MP4/MOV, and WebM that carries
// one) its header declares a duration in range. WHAT IT DOES NOT PROVE: that the frames decode, that the header is honest, or
// the duration of a WebM recorded live by a browser (such files usually carry no duration; durationSeconds is then null and the
// result says so). Do not describe this as content verification.

export type RangeReader = (start: number, endInclusive: number) => Promise<Uint8Array>;

export type Inspection =
  | { ok: true; container: "mp4" | "mov" | "webm"; durationSeconds: number | null }
  | { ok: false; reason: "notVideo" | "typeMismatch" | "unreadable" | "tooShort" | "tooLong" };

const HEAD_BYTES = 1024 * 1024; // WebM Info and Tracks sit at the start
const MAX_MOOV_BYTES = 4 * 1024 * 1024; // an MP4 index larger than this is not a 90-second clip
const MAX_BOX_HOPS = 12; // top-level boxes walked while looking for the index
const TOLERANCE_SECONDS = 1; // headers round; the browser check already enforces the exact 30 to 90

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at);
const u64 = (b: Uint8Array, at: number) => Number(new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(at));

function judge(container: "mp4" | "mov" | "webm", seconds: number | null): Inspection {
  if (seconds !== null) {
    if (!Number.isFinite(seconds) || seconds < 0) return { ok: false, reason: "unreadable" };
    if (seconds < MIN_SECONDS - TOLERANCE_SECONDS) return { ok: false, reason: "tooShort" };
    if (seconds > MAX_SECONDS + TOLERANCE_SECONDS) return { ok: false, reason: "tooLong" };
  }
  return { ok: true, container, durationSeconds: seconds };
}

// ---- MP4 / MOV (ISO base media): a sequence of boxes [size:4][type:4], size 1 means a 64-bit size follows ----
async function inspectIsoBmff(type: string, size: number, read: RangeReader): Promise<Inspection> {
  const first = await read(0, Math.min(size, 16) - 1);
  if (first.length < 8) return { ok: false, reason: "notVideo" };
  const firstType = ascii(first, 4, 4);
  if (!["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(firstType)) return { ok: false, reason: "notVideo" };
  if (type === "video/mp4" && firstType !== "ftyp") return { ok: false, reason: "typeMismatch" };
  const container = type === "video/quicktime" || (firstType === "ftyp" && ascii(first, 8, 4) === "qt  ") ? "mov" : "mp4";

  let offset = 0;
  for (let hop = 0; hop < MAX_BOX_HOPS && offset < size; hop++) {
    const head = await read(offset, Math.min(offset + 15, size - 1));
    if (head.length < 8) break;
    let boxSize = u32(head, 0);
    const boxType = ascii(head, 4, 4);
    if (boxSize === 1) {
      if (head.length < 16) break;
      boxSize = u64(head, 8);
    } else if (boxSize === 0) {
      boxSize = size - offset; // runs to the end of the file
    }
    if (boxSize < 8) return { ok: false, reason: "unreadable" };
    if (boxType === "moov") {
      if (boxSize > MAX_MOOV_BYTES || offset + boxSize > size) return { ok: false, reason: "unreadable" };
      const moov = await read(offset, offset + boxSize - 1);
      return judge(container, durationFromMoov(moov));
    }
    offset += boxSize;
  }
  return { ok: false, reason: "unreadable" }; // no movie index within reach: cannot say it is a video
}

/** The duration of an MP4/MOV `moov` box, or null when there is no video track or no readable mvhd. */
function durationFromMoov(moov: Uint8Array): number | null {
  let hasVideo = false;
  for (let i = 12; i + 4 <= moov.length; i++) if (moov[i] === 0x76 && ascii(moov, i, 4) === "vide") hasVideo = true; // hdlr handler type
  if (!hasVideo) throw new RangeError("no video track");
  let at = 8;
  while (at + 8 <= moov.length) {
    const boxSize = u32(moov, at);
    const boxType = ascii(moov, at + 4, 4);
    if (boxSize < 8) break;
    if (boxType === "mvhd") {
      const v = moov[at + 8];
      const base = at + 12; // after size, type, version+flags
      let timescale = 0;
      let duration = 0;
      if (v === 1 && base + 28 <= moov.length) [timescale, duration] = [u32(moov, base + 16), u64(moov, base + 20)];
      else if (v === 0 && base + 16 <= moov.length) [timescale, duration] = [u32(moov, base + 8), u32(moov, base + 12)];
      else return null;
      return duration === 0 ? fragmentedDuration(moov, timescale) : durationOf(timescale, duration);
    }
    at += boxSize;
  }
  return null;
}

/**
 * A fragmented MP4 (what a browser's MediaRecorder writes) keeps its movie header duration at 0 and puts the real length in the
 * fragments. If a `mehd` box declares the total, use it; otherwise the length is unknown (null), exactly like a live WebM.
 * A header duration of 0 WITHOUT the fragmented-movie marker (`mvex`) is a genuinely empty clip: it stays 0 and is refused as too short.
 */
function fragmentedDuration(moov: Uint8Array, timescale: number): number | null {
  let fragmented = false;
  let declared: number | null = null;
  for (let i = 4; i + 8 <= moov.length; i++) {
    if (moov[i] === 0x6d) {
      const t = ascii(moov, i, 4);
      if (t === "mvex") fragmented = true;
      if (t === "mehd" && i + 16 <= moov.length) declared = moov[i + 4] === 1 && i + 20 <= moov.length ? u64(moov, i + 8) : u32(moov, i + 8);
    }
  }
  if (!fragmented) return 0;
  return declared && declared > 0 ? durationOf(timescale, declared) : null;
}
const durationOf = (timescale: number, duration: number) => (timescale > 0 ? duration / timescale : null);

// ---- WebM (Matroska/EBML) ----
const EBML = { header: 0x1a45dfa3, segment: 0x18538067, info: 0x1549a966, tracks: 0x1654ae6b, cluster: 0x1f43b675, trackEntry: 0xae, trackType: 0x83, timecodeScale: 0x2ad7b1, duration: 0x4489, docType: 0x4282 };

/** Reads one element header at `at`: the id (marker bits kept), the data size (-1 when unknown) and where the data starts. */
function element(b: Uint8Array, at: number): { id: number; size: number; data: number } | null {
  if (at >= b.length) return null;
  const idLen = Math.clz32(b[at]!) - 24 + 1;
  if (idLen < 1 || idLen > 4 || at + idLen >= b.length) return null;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + b[at + i]!;
  const sAt = at + idLen;
  const sLen = Math.clz32(b[sAt]!) - 24 + 1;
  if (sLen < 1 || sLen > 8 || sAt + sLen > b.length) return null;
  let size = b[sAt]! & (0xff >> sLen);
  let allOnes = size === 0xff >> sLen;
  for (let i = 1; i < sLen; i++) {
    size = size * 256 + b[sAt + i]!;
    if (b[sAt + i] !== 0xff) allOnes = false;
  }
  return { id, size: allOnes ? -1 : size, data: sAt + sLen };
}
const uint = (b: Uint8Array, at: number, n: number) => b.subarray(at, at + n).reduce((acc, v) => acc * 256 + v, 0);
const float = (b: Uint8Array, at: number, n: number) => (n === 4 ? new DataView(b.buffer, b.byteOffset + at, 4).getFloat32(0) : n === 8 ? new DataView(b.buffer, b.byteOffset + at, 8).getFloat64(0) : NaN);

function inspectWebm(b: Uint8Array): Inspection {
  if (b.length < 4 || uint(b, 0, 4) !== EBML.header) return { ok: false, reason: "notVideo" };
  const header = element(b, 0);
  if (!header || header.size < 0) return { ok: false, reason: "unreadable" };
  // DocType must say webm
  for (let at = header.data; at < header.data + header.size; ) {
    const e = element(b, at);
    if (!e || e.size < 0) return { ok: false, reason: "unreadable" };
    if (e.id === EBML.docType && ascii(b, e.data, e.size) !== "webm") return { ok: false, reason: "typeMismatch" };
    at = e.data + e.size;
  }
  const segment = element(b, header.data + header.size);
  if (!segment || segment.id !== EBML.segment) return { ok: false, reason: "unreadable" };

  let scale = 1_000_000;
  let rawDuration: number | null = null;
  let video = false;
  for (let at = segment.data; at < b.length; ) {
    const e = element(b, at);
    if (!e || e.id === EBML.cluster) break; // Info and Tracks come before the first cluster
    if (e.size < 0) break;
    const end = Math.min(e.data + e.size, b.length);
    if (e.id === EBML.info) {
      for (let c = e.data; c < end; ) {
        const child = element(b, c);
        if (!child || child.size < 0) break;
        if (child.id === EBML.timecodeScale) scale = uint(b, child.data, child.size);
        if (child.id === EBML.duration) rawDuration = float(b, child.data, child.size);
        c = child.data + child.size;
      }
    } else if (e.id === EBML.tracks) {
      for (let c = e.data; c < end; ) {
        const entry = element(b, c);
        if (!entry || entry.size < 0) break;
        if (entry.id === EBML.trackEntry) {
          for (let t = entry.data; t < Math.min(entry.data + entry.size, end); ) {
            const f = element(b, t);
            if (!f || f.size < 0) break;
            if (f.id === EBML.trackType && uint(b, f.data, f.size) === 1) video = true;
            t = f.data + f.size;
          }
        }
        c = entry.data + entry.size;
      }
    }
    at = e.data + e.size;
  }
  if (!video) return { ok: false, reason: "notVideo" };
  return judge("webm", rawDuration === null ? null : (rawDuration * scale) / 1e9);
}

/** Looks at the stored object through small ranged reads. `type` is the content type the parent declared and R2 stored. */
export async function inspectVideo(type: string, size: number, read: RangeReader): Promise<Inspection> {
  if (size < 16) return { ok: false, reason: "notVideo" };
  try {
    if (type === "video/webm") return inspectWebm(await read(0, Math.min(size, HEAD_BYTES) - 1));
    if (type === "video/mp4" || type === "video/quicktime") return await inspectIsoBmff(type, size, read);
    return { ok: false, reason: "typeMismatch" };
  } catch (e) {
    // A parsing overrun is a RangeError: the bytes are not the container they claim. Anything else (the bucket failing) is
    // rethrown so the caller reports "unavailable" and the parent can retry, instead of blaming the video.
    if (e instanceof RangeError) return { ok: false, reason: "notVideo" };
    throw e;
  }
}
