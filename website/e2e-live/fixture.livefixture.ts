// OFFLINE video-fixture compatibility check for the live journey. It contacts NO server: it records an MP4 in the installed Chrome,
// converts it to an ordinary MP4, plays it back, and runs the REAL server-side inspector on the bytes. Run it with
//
//   npm run test:fixture
//
// It proves three things before any hosted test is allowed: (1) the file is a genuine, playable MP4 with a duration in its header,
// (2) the real inspector accepts it AND reads the true duration (not "unknown"), (3) the inspector does not accept it under a
// spoofed Content-Type. The Content-Type used by the journey is the file's true type, video/mp4.

import { expect, test } from "@playwright/test";
import { inspectVideo } from "../lib/submit/inspect";
import { mp4Problems } from "../scripts/live-journey";
import { generateMp4 } from "./media";

const SECONDS = 31;

test("the MP4 fixture is genuine, plays, and passes the real inspector with its true duration", async ({ browser }) => {
  test.setTimeout(240_000);
  const fixture = await generateMp4(browser, SECONDS);
  const { data, facts, header } = fixture;

  // 1. genuine and playable, measured by Chrome itself
  expect(mp4Problems(facts, header, SECONDS)).toEqual([]);
  test.info().annotations.push({
    type: "fixture",
    description: `MP4 (H.264) ${data.length} bytes, ${facts.width}x${facts.height}, Chrome measured ${facts.duration.toFixed(2)} s, header says ${header.seconds.toFixed(2)} s, ${header.samples} samples, not fragmented, played: ${facts.played}`,
  });

  // 2. the real inspector, through ranged reads exactly like the server's
  const reads: number[] = [];
  const read = async (start: number, end: number) => {
    reads.push(end - start + 1);
    return new Uint8Array(data.subarray(start, end + 1));
  };
  const verdict = await inspectVideo("video/mp4", data.length, read);
  expect(verdict.ok).toBe(true);
  if (verdict.ok) {
    expect(verdict.container).toBe("mp4");
    expect(verdict.durationSeconds).not.toBeNull(); // a real duration, not "unknown"
    expect(Math.abs((verdict.durationSeconds ?? 0) - facts.duration)).toBeLessThan(0.3);
    expect(verdict.durationSeconds!).toBeGreaterThanOrEqual(30);
    expect(verdict.durationSeconds!).toBeLessThanOrEqual(90);
  }
  expect(Math.max(...reads)).toBeLessThan(5 * 1024 * 1024); // bounded: it never read the whole file in one go
  expect(reads.length).toBeLessThanOrEqual(14);

  // 3. no spoofing: the same bytes under another Content-Type are NOT accepted as that type
  expect((await inspectVideo("video/webm", data.length, read)).ok).toBe(false);
  expect((await inspectVideo("text/plain", data.length, read)).ok).toBe(false);
  // and damaging the header makes the real inspector refuse it (the check is not a rubber stamp)
  const damaged = Buffer.from(data);
  damaged.write("xxxx", 4, "latin1"); // the ftyp box type
  expect((await inspectVideo("video/mp4", damaged.length, async (s, e) => new Uint8Array(damaged.subarray(s, e + 1)))).ok).toBe(false);
});
