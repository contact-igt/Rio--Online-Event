import { describe, expect, it } from "vitest";
import { countRegistrations, filterRegistrations, PAGE_SIZE, paginate, parseFilters, statusLabel, videoLabel, type Registration } from "./registrations";
import { formatIst } from "./format";

const base: Registration = {
  id: "i", entryCode: "RIO-AAAAA-00001", eventId: 2, status: "draft", childName: "Asha", childAge: 6, parentName: "Meena", parentEmail: "meena@example.test",
  parentMobile: "+91 98765 43210", consentVersion: "v1", consentAt: null, mediaConsent: null, hasVideo: false, createdAt: "2026-11-07T00:00:00Z", updatedAt: null, finalizedAt: null, withdrawnAt: null,
};
const row = (o: Partial<Registration>): Registration => ({ ...base, ...o });

describe("counts", () => {
  it("count each state from the rows, and only finalized is a completed submission", () => {
    const rows = [row({ status: "draft" }), row({ status: "draft" }), row({ status: "uploaded", hasVideo: true }), row({ status: "finalized", hasVideo: true }), row({ status: "withdrawn" })];
    expect(countRegistrations(rows)).toEqual({ total: 5, draft: 2, awaiting: 1, finalized: 1, withdrawn: 1 });
    expect(countRegistrations([])).toEqual({ total: 0, draft: 0, awaiting: 0, finalized: 0, withdrawn: 0 });
    expect(statusLabel.draft).toMatch(/not submitted/i);
  });
  it("describe the video in words from the status and the object reference", () => {
    expect(videoLabel({ status: "draft", hasVideo: false })).toBe("No video yet");
    expect(videoLabel({ status: "uploaded", hasVideo: true })).toBe("Uploaded and verified");
    expect(videoLabel({ status: "finalized", hasVideo: true })).toBe("Uploaded and verified");
    expect(videoLabel({ status: "withdrawn", hasVideo: false })).toBe("No video");
  });
});

describe("parseFilters", () => {
  it("accepts known values and turns anything else into 'no filter'", () => {
    expect(parseFilters({ q: "  asha ", status: "finalized", event: "3", page: "2" })).toEqual({ q: "asha", status: "finalized", event: 3, page: 2 });
    expect(parseFilters({ status: "admin", event: "99", page: "-4" })).toEqual({ q: "", status: "", event: null, page: 1 });
    expect(parseFilters({ status: ["draft", "finalized"], event: "abc", page: "1e9", q: ["x"] })).toEqual({ q: "", status: "", event: null, page: 1 });
    expect(parseFilters({ q: "x".repeat(500) }).q).toHaveLength(100);
    expect(parseFilters({ page: "999999" }).page).toBe(1000);
  });
});

describe("filterRegistrations", () => {
  const rows = [
    row({ id: "1", childName: "Asha", status: "draft", entryCode: "RIO-AAAAA-11111" }),
    row({ id: "2", childName: "Bala", parentName: "Kavitha", status: "finalized", eventId: 3, entryCode: "RIO-BBBBB-22222", parentEmail: "kavi@example.test", parentMobile: "9811111111" }),
    row({ id: "3", childName: "ஆஷா", status: "uploaded", eventId: 3, entryCode: "RIO-CCCCC-33333" }),
  ];
  const ids = (f: Partial<Parameters<typeof filterRegistrations>[1]>) => filterRegistrations(rows, { q: "", status: "", event: null, ...f }).map((r) => r.id);

  it("searches reference, child, parent, e-mail and mobile, ignoring case, including Tamil names", () => {
    expect(ids({ q: "rio-bbbbb" })).toEqual(["2"]);
    expect(ids({ q: "ASHA" })).toEqual(["1"]);
    expect(ids({ q: "kavitha" })).toEqual(["2"]);
    expect(ids({ q: "KAVI@" })).toEqual(["2"]);
    expect(ids({ q: "98 11111" })).toEqual(["2"]);
    expect(ids({ q: "ஆஷா" })).toEqual(["3"]);
    expect(ids({ q: "no such" })).toEqual([]);
  });
  it("does not match a short run of digits against mobiles (no accidental broad matches)", () => {
    expect(ids({ q: "98" })).toEqual([]);
  });
  it("filters by status and competition together", () => {
    expect(ids({ status: "finalized" })).toEqual(["2"]);
    expect(ids({ event: 3 })).toEqual(["2", "3"]);
    expect(ids({ event: 3, status: "uploaded" })).toEqual(["3"]);
    expect(ids({ status: "draft", event: 3 })).toEqual([]);
  });
  it("treats search text as plain text: filter syntax and wildcards are not special", () => {
    for (const q of ["%", "_", "*", ",status.eq.finalized", "') or true --", "\\"]) expect(ids({ q })).toEqual([]);
  });
});

describe("paginate", () => {
  it("pages the rows and clamps the page", () => {
    const rows = Array.from({ length: PAGE_SIZE * 2 + 3 }, (_, i) => i);
    expect(paginate(rows, 1)).toMatchObject({ pages: 3, page: 1 });
    expect(paginate(rows, 1).items).toHaveLength(PAGE_SIZE);
    expect(paginate(rows, 3).items).toEqual([PAGE_SIZE * 2, PAGE_SIZE * 2 + 1, PAGE_SIZE * 2 + 2]);
    expect(paginate(rows, 50)).toMatchObject({ page: 3 });
    expect(paginate([], 1)).toEqual({ items: [], pages: 1, page: 1 });
  });
});

describe("formatIst", () => {
  it("shows Indian Standard Time and an en dash for nothing", () => {
    expect(formatIst("2026-11-07T10:00:00Z")).toMatch(/7 Nov 2026/);
    expect(formatIst("2026-11-07T10:00:00Z")).toMatch(/3:30/); // 10:00 UTC is 15:30 IST
    expect(formatIst(null)).toBe("–");
    expect(formatIst("garbage")).toBe("–");
  });
});
