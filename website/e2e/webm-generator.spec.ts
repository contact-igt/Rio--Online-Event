import { expect, test } from "@playwright/test";
import { generateWebm } from "../e2e-live/media";

// Offline check that the live upload test's video generator works in this machine's Chrome: it must produce a real WebM file
// (EBML header), decodable, with a picture, that actually plays, of about the requested length. A short clip keeps the normal
// suite fast (6 s: the very first recording of a fresh browser can take a few seconds to start producing data, so shorter clips
// are unreliable); the live suite records 31 seconds. Nothing here contacts any server.

test("the test-video generator produces a genuine, decodable, playable WebM of the requested length", async ({ browser }) => {
  const { data, facts } = await generateWebm(browser, 6);
  expect(Array.from(data.subarray(0, 4))).toEqual([0x1a, 0x45, 0xdf, 0xa3]); // the EBML magic number every WebM/Matroska file starts with
  expect(facts.bytes).toBe(data.length);
  expect(facts.mime.startsWith("video/webm")).toBe(true);
  expect(facts.duration).toBeGreaterThan(5);
  expect(facts.duration).toBeLessThan(8);
  expect(facts.width).toBe(320);
  expect(facts.height).toBe(240);
  expect(facts.played).toBe(true);
});
