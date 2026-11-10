import { describe, expect, it } from "vitest";
import { checkFile, checkVideo, MAX_VIDEO_BYTES, MIN_VIDEO_BYTES, videoTypeOf } from "./rules";

const ok = { type: "video/mp4", bytes: 20 * 1024 * 1024, seconds: 45 };

describe("checkVideo", () => {
  it("accepts MP4, MOV and WebM from 100 KB to 100 MB and 30 to 90 seconds, boundaries included", () => {
    for (const type of ["video/mp4", "video/quicktime", "video/webm"]) expect(checkVideo({ ...ok, type }), type).toBeNull();
    expect(checkVideo({ ...ok, bytes: MAX_VIDEO_BYTES })).toBeNull();
    expect(checkVideo({ ...ok, bytes: MIN_VIDEO_BYTES })).toBeNull();
    expect(checkVideo({ ...ok, seconds: 30 })).toBeNull();
    expect(checkVideo({ ...ok, seconds: 90 })).toBeNull();
  });

  it("rounds the length to the nearest second, so a 30 second clip that reads 29.6 passes and 29.4 does not", () => {
    expect(checkVideo({ ...ok, seconds: 29.6 })).toBeNull();
    expect(checkVideo({ ...ok, seconds: 29.4 })).toBe("tooShort");
    expect(checkVideo({ ...ok, seconds: 90.4 })).toBeNull();
    expect(checkVideo({ ...ok, seconds: 90.6 })).toBe("tooLong");
  });

  it("names the first rule that is broken", () => {
    expect(checkVideo({ ...ok, type: "application/pdf" })).toBe("type");
    expect(checkVideo({ ...ok, type: "" })).toBe("type");
    expect(checkVideo({ ...ok, type: "video/x-msvideo" })).toBe("type");
    expect(checkVideo({ ...ok, bytes: MAX_VIDEO_BYTES + 1 })).toBe("tooBig");
    expect(checkVideo({ ...ok, bytes: MIN_VIDEO_BYTES - 1 })).toBe("tooSmall");
    expect(checkVideo({ ...ok, bytes: Number.NaN })).toBe("tooSmall");
    expect(checkVideo({ ...ok, seconds: 12 })).toBe("tooShort");
    expect(checkVideo({ ...ok, seconds: 600 })).toBe("tooLong");
    expect(checkVideo({ ...ok, seconds: null })).toBe("unreadable");
    expect(checkVideo({ ...ok, seconds: Number.POSITIVE_INFINITY })).toBe("unreadable");
  });

  it("checkFile does the cheap type and size checks without needing a length", () => {
    expect(checkFile({ type: "video/mp4", bytes: 5_000_000 })).toBeNull();
    expect(checkFile({ type: "image/png", bytes: 5_000_000 })).toBe("type");
    expect(checkFile({ type: "video/mp4", bytes: MAX_VIDEO_BYTES + 1 })).toBe("tooBig");
  });
});

describe("videoTypeOf", () => {
  it("trusts the browser's type, and falls back to the extension when there is none", () => {
    expect(videoTypeOf({ type: "VIDEO/MP4", name: "a.bin" })).toBe("video/mp4");
    expect(videoTypeOf({ type: "", name: "Clip.MOV" })).toBe("video/quicktime");
    expect(videoTypeOf({ type: "", name: "clip.m4v" })).toBe("video/mp4");
    expect(videoTypeOf({ type: "", name: "clip.exe" })).toBe("");
    expect(videoTypeOf({ type: "", name: "noextension" })).toBe("");
  });
});
