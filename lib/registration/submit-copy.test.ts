import { describe, expect, it } from "vitest";
import type { FinalizeErrorCode } from "@/lib/submit/service";
import { formatDateBilingual } from "./date";
import { reg } from "./messages";

// Exhaustive by construction: adding a code to FinalizeErrorCode without a line here fails the typecheck.
const CODES = Object.keys({ invalid: 1, notFound: 1, status: 1, closed: 1, locked: 1, noVideo: 1, videoNotVerified: 1, videoMissing: 1, videoChanged: 1, videoInvalid: 1, videoDuration: 1, consent: 1, duplicate: 1, tooMany: 1, unavailable: 1 } satisfies Record<FinalizeErrorCode, 1>);

const leaves = (value: unknown, path = "submit"): { path: string; value: unknown }[] =>
  value && typeof value === "object" && !("ta" in value && "en" in value)
    ? Object.entries(value).flatMap(([k, v]) => leaves(v, `${path}.${k}`))
    : [{ path, value }];

describe("formatDateBilingual", () => {
  it("shows Tamil first and English second, in Indian time", () => {
    expect(formatDateBilingual("2026-11-05T10:00:00Z")).toBe("5 நவம்பர் 2026 / 5 Nov 2026");
    // 20:00 UTC on the 5th is already the 6th in India
    expect(formatDateBilingual("2026-11-05T20:00:00Z")).toBe("6 நவம்பர் 2026 / 6 Nov 2026");
  });
  it("shows nothing for a missing or invalid date", () => {
    expect(formatDateBilingual(null)).toBe("");
    expect(formatDateBilingual(undefined)).toBe("");
    expect(formatDateBilingual("")).toBe("");
    expect(formatDateBilingual("not a date")).toBe("");
  });
});

describe("final submission copy", () => {
  it("every string has both languages, and neither is empty", () => {
    for (const { path, value } of leaves(reg.submit)) {
      // emailNote takes the masked address; call it with a sample so it is checked like the others
      const s = (typeof value === "function" ? value("p***@example.org") : value) as { ta: string; en: string };
      expect(typeof s.ta === "string" && s.ta.trim().length > 0, `${path}.ta`).toBe(true);
      expect(typeof s.en === "string" && s.en.trim().length > 0, `${path}.en`).toBe(true);
    }
  });

  it("every failure code the server can return has a message", () => {
    for (const code of CODES) expect(reg.submit.errors, code).toHaveProperty(code);
  });

  it("says that submitting is final, and never says the optional media permission is required", () => {
    expect(reg.submit.final.en).toMatch(/final/i);
    const media = `${reg.submit.mediaGiven.en} ${reg.submit.mediaNotGiven.en}`;
    expect(media).toMatch(/optional/i);
    expect(media).toMatch(/not needed|can still enter/i);
    expect(media).not.toMatch(/you must|required to/i);
  });
});
