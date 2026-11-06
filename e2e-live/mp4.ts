// Turns the FRAGMENTED MP4 that Chrome's MediaRecorder writes (movie header duration 0, real length only in the fragments) into an
// ordinary progressive MP4 with a complete sample table and the true duration in its header, the layout a phone camera file has.
// The encoded H.264 samples are copied byte for byte; only the container around them is rebuilt. Test-support code: it makes the
// live journey's video fixture and touches no server. Single video track only (a canvas recording has no audio).

type Box = { type: string; start: number; end: number; header: number };

function readBoxes(buf: Buffer, start = 0, end = buf.length): Box[] {
  const out: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = buf.readUInt32BE(at);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) throw new Error("damaged MP4 box");
    out.push({ type: buf.toString("latin1", at + 4, at + 8), start: at, end: at + size, header });
    at += size;
  }
  return out;
}
const kids = (buf: Buffer, b: Box, skip = 0) => readBoxes(buf, b.start + b.header + skip, b.end);
const find = (list: Box[], type: string) => list.find((b) => b.type === type);
const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`MP4 has no ${what}`);
  return v;
};
const mk = (type: string, ...parts: Buffer[]) => {
  const payload = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, payload]);
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

type Sample = { offset: number; size: number; duration: number; sync: boolean; cto: number };

function readSamples(buf: Buffer, top: Box[], trex: { duration: number; size: number; flags: number }): Sample[] {
  const samples: Sample[] = [];
  for (const moof of top.filter((b) => b.type === "moof")) {
    for (const traf of kids(buf, moof).filter((b) => b.type === "traf")) {
      const parts = kids(buf, traf);
      const tfhd = need(find(parts, "tfhd"), "tfhd");
      const flags = buf.readUInt32BE(tfhd.start + 8) & 0xffffff;
      let p = tfhd.start + 8 + 8; // version+flags, track id
      let base = moof.start;
      if (flags & 0x1) {
        base = Number(buf.readBigUInt64BE(p));
        p += 8;
      }
      if (flags & 0x2) p += 4;
      let defDuration = trex.duration;
      let defSize = trex.size;
      let defFlags = trex.flags;
      if (flags & 0x8) {
        defDuration = buf.readUInt32BE(p);
        p += 4;
      }
      if (flags & 0x10) {
        defSize = buf.readUInt32BE(p);
        p += 4;
      }
      if (flags & 0x20) {
        defFlags = buf.readUInt32BE(p);
        p += 4;
      }
      for (const trun of parts.filter((b) => b.type === "trun")) {
        const tf = buf.readUInt32BE(trun.start + 8) & 0xffffff;
        const count = buf.readUInt32BE(trun.start + 12);
        let q = trun.start + 16;
        let data = base;
        if (tf & 0x1) {
          data = base + buf.readInt32BE(q);
          q += 4;
        }
        let first: number | null = null;
        if (tf & 0x4) {
          first = buf.readUInt32BE(q);
          q += 4;
        }
        for (let i = 0; i < count; i++) {
          const duration = tf & 0x100 ? buf.readUInt32BE((q += 4) - 4) : defDuration;
          const size = tf & 0x200 ? buf.readUInt32BE((q += 4) - 4) : defSize;
          const sflags = tf & 0x400 ? buf.readUInt32BE((q += 4) - 4) : i === 0 && first !== null ? first : defFlags;
          const cto = tf & 0x800 ? buf.readInt32BE((q += 4) - 4) : 0;
          samples.push({ offset: data, size, duration, sync: (sflags & 0x10000) === 0, cto });
          data += size;
        }
      }
    }
  }
  if (samples.length === 0) throw new Error("MP4 has no fragments to convert");
  return samples;
}

export function remuxFragmentedMp4(input: Buffer): Buffer {
  const top = readBoxes(input);
  const moov = need(find(top, "moov"), "moov");
  const moovKids = kids(input, moov);
  const mvhd = need(find(moovKids, "mvhd"), "mvhd");
  const trak = need(moovKids.filter((b) => b.type === "trak")[0], "trak");
  const trexBox = find(kids(input, need(find(moovKids, "mvex"), "mvex")), "trex");
  const trex = trexBox
    ? { duration: input.readUInt32BE(trexBox.start + 8 + 12), size: input.readUInt32BE(trexBox.start + 8 + 16), flags: input.readUInt32BE(trexBox.start + 8 + 20) }
    : { duration: 0, size: 0, flags: 0 };

  const trakKids = kids(input, trak);
  const mdia = need(find(trakKids, "mdia"), "mdia");
  const mdiaKids = kids(input, mdia);
  const mdhd = need(find(mdiaKids, "mdhd"), "mdhd");
  const minf = need(find(mdiaKids, "minf"), "minf");
  const minfKids = kids(input, minf);
  const stbl = need(find(minfKids, "stbl"), "stbl");
  const stsd = need(find(kids(input, stbl), "stsd"), "stsd");

  const samples = readSamples(input, top, trex);
  const mdhdV = input[mdhd.start + 8]!;
  const trackScale = input.readUInt32BE(mdhd.start + 8 + (mdhdV === 1 ? 20 : 12));
  const mvhdV = input[mvhd.start + 8]!;
  const movieScale = input.readUInt32BE(mvhd.start + 8 + (mvhdV === 1 ? 20 : 12));
  const total = samples.reduce((n, s) => n + s.duration, 0);
  const movieDuration = Math.round((total * movieScale) / trackScale);

  const patched = (b: Box, versioned: [v0: number, v1: number], value: number) => {
    const copy = Buffer.from(input.subarray(b.start, b.end));
    const v = copy[8]!;
    if (v === 1) copy.writeBigUInt64BE(BigInt(value), versioned[1] + 8);
    else copy.writeUInt32BE(value, versioned[0] + 8);
    return copy;
  };
  const raw = (b: Box) => Buffer.from(input.subarray(b.start, b.end));

  // sample table
  const stts: Buffer[] = [];
  let runs = 0;
  for (let i = 0; i < samples.length; ) {
    let j = i;
    while (j < samples.length && samples[j]!.duration === samples[i]!.duration) j++;
    stts.push(u32(j - i), u32(samples[i]!.duration));
    runs++;
    i = j;
  }
  const hasCto = samples.some((s) => s.cto !== 0);
  const syncIdx = samples.flatMap((s, i) => (s.sync ? [i + 1] : []));

  const build = (chunkOffset: number) => {
    const stblBox = mk(
      "stbl",
      raw(stsd),
      mk("stts", u32(0), u32(runs), ...stts),
      ...(hasCto ? [mk("ctts", u32(0), u32(samples.length), ...samples.flatMap((s) => [u32(1), u32(s.cto)]))] : []),
      mk("stsc", u32(0), u32(1), u32(1), u32(samples.length), u32(1)),
      mk("stsz", u32(0), u32(0), u32(samples.length), ...samples.map((s) => u32(s.size))),
      mk("stco", u32(0), u32(1), u32(chunkOffset)),
      ...(syncIdx.length < samples.length ? [mk("stss", u32(0), u32(syncIdx.length), ...syncIdx.map(u32))] : []),
    );
    const minfNew = mk("minf", ...minfKids.filter((b) => b.type !== "stbl").map(raw), stblBox);
    const mdiaNew = mk("mdia", ...mdiaKids.map((b) => (b.type === "mdhd" ? patched(b, [16, 24], total) : b.type === "minf" ? minfNew : raw(b))));
    const trakNew = mk("trak", ...trakKids.filter((b) => b.type !== "edts").map((b) => (b.type === "tkhd" ? patched(b, [20, 28], movieDuration) : b.type === "mdia" ? mdiaNew : raw(b))));
    return mk("moov", ...moovKids.filter((b) => b.type !== "mvex" && b.type !== "trak").map((b) => (b.type === "mvhd" ? patched(b, [16, 24], movieDuration) : raw(b))), trakNew);
  };

  const ftyp = mk("ftyp", Buffer.from("isom"), u32(512), Buffer.from("isomiso2avc1mp41"));
  const size = build(0).length;
  const moovFinal = build(ftyp.length + size + 8);
  const body = Buffer.concat(samples.map((s) => input.subarray(s.offset, s.offset + s.size)));
  return Buffer.concat([ftyp, moovFinal, mk("mdat", body)]);
}

/** Facts read back from a finished MP4 (for tests and for the fixture gate): no fragments, true duration, sample count. */
export function describeMp4(buf: Buffer): { fragmented: boolean; seconds: number; samples: number; bytes: number } {
  const top = readBoxes(buf);
  const moov = need(find(top, "moov"), "moov");
  const moovKids = kids(buf, moov);
  const mvhd = need(find(moovKids, "mvhd"), "mvhd");
  const v = buf[mvhd.start + 8]!;
  const scale = buf.readUInt32BE(mvhd.start + 8 + (v === 1 ? 20 : 12));
  const dur = v === 1 ? Number(buf.readBigUInt64BE(mvhd.start + 8 + 24)) : buf.readUInt32BE(mvhd.start + 8 + 16);
  const stbl = need(find(kids(buf, need(find(kids(buf, need(find(kids(buf, need(moovKids.filter((b) => b.type === "trak")[0], "trak")), "mdia"), "mdia")), "minf"), "minf")), "stbl"), "stbl");
  const stsz = need(find(kids(buf, stbl), "stsz"), "stsz");
  return {
    fragmented: top.some((b) => b.type === "moof") || moovKids.some((b) => b.type === "mvex"),
    seconds: dur / scale,
    samples: buf.readUInt32BE(stsz.start + 16),
    bytes: buf.length,
  };
}
