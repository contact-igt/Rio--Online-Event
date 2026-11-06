import { describe, expect, it } from "vitest";
import { AGES, events, fitsAge } from "@/lib/events";
import { getConsentCopy, PROVISIONAL_VERSION } from "./consent";
import { findConflicts, mobileKey, normalizeChildName, type OwnSubmission } from "./duplicates";
import { registrationWriteError } from "./errors";
import { maskMobile } from "./mask";
import { reg } from "./messages";
import { draftIdSchema, normalizeMobile, parseRegistration, pickFields } from "./schemas";
import { isRegistrationOpen } from "./settings";

const valid = { childName: "Asha Kumar", childAge: "9", parentName: "Meena Kumar", mobile: "9876543210", guardianConsent: "on" };
const kutti = events.find((e) => e.slug === "kutti-pesalar")!; // ages 8-12

describe("child and parent names", () => {
  const ok = (name: string) => parseRegistration(kutti, { ...valid, childName: name }, true).ok;

  it("accept Tamil, Latin and mixed names with spaces, dots, apostrophes and hyphens", () => {
    for (const n of ["Asha", "ஆஷா குமார்", "சிவா  குமார்", "Mary-Jane O'Neil", "A. R. Rahman", "நிலா ராணி"]) expect(ok(n), n).toBe(true);
  });
  it("collapse and trim whitespace", () => {
    const r = parseRegistration(kutti, { ...valid, childName: "  Asha    Kumar " }, true);
    expect(r.ok && r.data.childName).toBe("Asha Kumar");
  });
  it("reject empty, numeric, symbol-only, markup and over-long names", () => {
    for (const n of ["", "   ", "Asha 2", "12345", "<script>", "Asha@home", "-Asha", "x".repeat(81)]) expect(ok(n), n).toBe(false);
  });
  it("accept exactly 80 characters", () => expect(ok("a".repeat(80))).toBe(true));
});

describe("mobile numbers (10-digit Indian mobile)", () => {
  it("normalize every accepted spelling to +91 and ten digits", () => {
    for (const m of ["9876543210", "+919876543210", "+91 98765 43210", "919876543210", "09876543210", "98765-43210", "(98765) 43210"]) {
      expect(normalizeMobile(m), m).toBe("+919876543210");
    }
  });
  it("reject short, long, wrong-prefix, foreign and non-numeric input", () => {
    for (const m of ["", "12345", "98765432", "98765432101234", "5876543210", "1234567890", "+14155550100", "abcdefghij", "9876543210x", "98765 4321 0 0"]) {
      expect(normalizeMobile(m), m).toBeNull();
    }
  });
  it("accept every leading digit 6-9 and none below", () => {
    for (const d of [6, 7, 8, 9]) expect(normalizeMobile(`${d}123456789`)).toBe(`+91${d}123456789`);
    for (const d of [0, 1, 2, 3, 4, 5]) expect(normalizeMobile(`${d}123456789`)).toBeNull();
  });
});

describe("age and the six competition age bands", () => {
  it("accept exactly the ages each competition allows, for every age from 0 to 14 and every event", () => {
    for (const event of events) {
      for (let age = 0; age <= 14; age++) {
        const result = parseRegistration(event, { ...valid, childAge: String(age) }, true);
        const expected = age >= event.minAge && age <= event.maxAge;
        expect(result.ok, `${event.slug} age ${age}`).toBe(expected);
        if (!result.ok && age >= 3 && age <= 12) expect(result.errors.childAge?.en, `${event.slug} ${age}`).toMatch(/Only ages/);
      }
    }
  });
  it("match the shared lib/events.ts rule and cover every age 3-12 in some competition", () => {
    for (const age of AGES) expect(events.some((e) => fitsAge(e, age))).toBe(true);
    expect(events.map((e) => [e.minAge, e.maxAge])).toEqual([[3, 5], [5, 8], [6, 12], [8, 12], [5, 12], [6, 12]]);
  });
  it("reject non-numeric, fractional, negative and out-of-range ages with the general age message", () => {
    for (const a of ["", "x", "9.5", "-9", "013", "123", "2", "13"]) {
      const r = parseRegistration(kutti, { ...valid, childAge: a }, true);
      expect(r.ok, a).toBe(false);
    }
    const r = parseRegistration(kutti, { ...valid, childAge: "abc" }, true);
    expect(!r.ok && r.errors.childAge).toBe(reg.errors.age);
  });
});

describe("consent", () => {
  it("is required when creating, with its own error", () => {
    const r = parseRegistration(kutti, { ...valid, guardianConsent: "" }, true);
    expect(!r.ok && r.errors.guardianConsent).toBe(reg.errors.consent);
    expect(parseRegistration(kutti, { ...valid, guardianConsent: "yes" }, true).ok).toBe(false);
  });
  it("is not asked again when editing a draft", () => {
    expect(parseRegistration(kutti, { ...valid, guardianConsent: "" }, false).ok).toBe(true);
  });
  it("keeps the optional media consent separate: absent means no, and it never satisfies the guardian consent", () => {
    const none = parseRegistration(kutti, valid, true);
    expect(none.ok && none.data.mediaConsent).toBe(false);
    const media = parseRegistration(kutti, { ...valid, mediaConsent: "on" }, true);
    expect(media.ok && media.data.mediaConsent).toBe(true);
    expect(parseRegistration(kutti, { ...valid, guardianConsent: "", mediaConsent: "on" }, true).ok).toBe(false);
  });
});

describe("what is collected", () => {
  it("reads only the known fields and ignores owner, status, video, email and consent timestamp", () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ ...valid, owner_id: "x", parent_email: "evil@example.com", status: "finalized", video_key: "v", consent_at: "2020-01-01", entry_code: "RIO-1", dob: "2016-01-01" })) fd.set(k, v);
    expect(Object.keys(pickFields(fd)).sort()).toEqual(["childAge", "childName", "guardianConsent", "mobile", "parentName"]);
  });
  it("has no date-of-birth or other unnecessary child field in the validated data", () => {
    const r = parseRegistration(kutti, valid, true);
    expect(r.ok && Object.keys(r.data).sort()).toEqual(["childAge", "childName", "guardianConsent", "mediaConsent", "mobile", "parentName"]);
  });
  it("accepts only a UUID as a draft id", () => {
    expect(draftIdSchema.safeParse("3f2b8c1e-5d4a-4b6e-9c1a-7e8f9a0b1c2d").success).toBe(true);
    for (const bad of ["", "1", "../etc/passwd", "3f2b8c1e", "' or 1=1 --"]) expect(draftIdSchema.safeParse(bad).success, bad).toBe(false);
  });
});

describe("provisional consent wording", () => {
  const copy = getConsentCopy(PROVISIONAL_VERSION)!;
  it("is clearly labelled as provisional and never claims legal approval", () => {
    expect(copy.provisional).toBe(true);
    expect(copy.notice.en).toMatch(/provisional/i);
    expect(copy.notice.en).toMatch(/not yet been reviewed/i);
    const all = JSON.stringify(copy);
    expect(all).not.toMatch(/legally (approved|binding|reviewed)|approved by (the )?(legal|counsel)|complies with/i);
  });
  it("keeps guardian consent and optional media consent as separate statements", () => {
    expect(copy.guardian.en).not.toBe(copy.media.en);
    expect(copy.media.en).toMatch(/^Optional:/);
    expect(copy.media.en).toMatch(/can still take part/);
    expect(copy.guardian.en).not.toMatch(/winners post|announcements/i);
  });
  it("has Tamil and English for every statement, and is unknown for any other version", () => {
    for (const m of [copy.notice, copy.guardian, copy.media]) expect(m.ta.length).toBeGreaterThan(20);
    expect(getConsentCopy("v1")).toBeNull();
    expect(getConsentCopy(null)).toBeNull();
    expect(getConsentCopy("")).toBeNull();
  });
});

describe("registration stays closed until an administrator opens it", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  const open = { opensAt: "2026-11-09T00:00:00Z", closesAt: "2026-11-12T00:00:00Z", consentVersion: PROVISIONAL_VERSION };
  it("is open only inside the window with a known consent version", () => {
    expect(isRegistrationOpen(open, now)).toBe(true);
    expect(isRegistrationOpen(open, new Date("2026-11-09T00:00:00Z"))).toBe(true); // opens at the start instant
    expect(isRegistrationOpen(open, new Date("2026-11-12T00:00:00Z"))).toBe(false); // closes at the end instant
    expect(isRegistrationOpen(open, new Date("2026-11-08T23:59:59Z"))).toBe(false);
  });
  it("is closed for the state the dev database is in today, and for any missing or unknown setting", () => {
    expect(isRegistrationOpen({ opensAt: null, closesAt: null, consentVersion: null }, now)).toBe(false);
    expect(isRegistrationOpen(null, now)).toBe(false);
    expect(isRegistrationOpen({ ...open, opensAt: null }, now)).toBe(false);
    expect(isRegistrationOpen({ ...open, closesAt: null }, now)).toBe(false);
    expect(isRegistrationOpen({ ...open, consentVersion: null }, now)).toBe(false);
    expect(isRegistrationOpen({ ...open, consentVersion: "v9-unknown" }, now)).toBe(false);
  });
});

describe("duplicate detection (same normalization as the database)", () => {
  const row = (over: Partial<OwnSubmission>): OwnSubmission => ({ id: "a", event_id: 4, child_name: "Ravi Kumar", parent_mobile: "+919876543210", status: "draft", ...over });
  const cand = { eventId: 4, childName: "  ravi  KUMAR. ", mobile: "09876543210" };

  it("normalizes child names like child_name_norm, including Tamil", () => {
    expect(normalizeChildName("  Ravi   Kumar. ")).toBe("ravikumar");
    expect(normalizeChildName("சிவா  குமார்")).toBe("சிவாகுமார்");
    expect(mobileKey("+91 98765-43210")).toBe("9876543210");
    expect(mobileKey("09876543210")).toBe("9876543210");
  });
  it("finds the same child in the same competition however it is typed", () => {
    expect(findConflicts([row({})], cand).sameEvent?.id).toBe("a");
  });
  it("does not conflict for a sibling, a namesake on another phone, or the draft being edited", () => {
    expect(findConflicts([row({ child_name: "Bala" })], cand).sameEvent).toBeNull();
    expect(findConflicts([row({ parent_mobile: "+919123456780" })], cand).sameEvent).toBeNull();
    expect(findConflicts([row({})], cand, "a").sameEvent).toBeNull();
  });
  it("lets one child have drafts in several competitions, and reports them", () => {
    const c = findConflicts([row({ event_id: 2 })], cand);
    expect(c.sameEvent).toBeNull();
    expect(c.otherEvents).toHaveLength(1);
    expect(c.finalizedElsewhere).toBeNull();
  });
  it("blocks a child who already has a finalized entry elsewhere (one competition per child)", () => {
    expect(findConflicts([row({ event_id: 2, status: "finalized" })], cand).finalizedElsewhere?.event_id).toBe(2);
  });
  it("ignores withdrawn registrations", () => {
    const c = findConflicts([row({ status: "withdrawn" }), row({ id: "b", event_id: 2, status: "withdrawn" })], cand);
    expect(c).toEqual({ sameEvent: null, finalizedElsewhere: null, otherEvents: [] });
  });
});

describe("database failures become safe messages", () => {
  const band = { minAge: 8, maxAge: 12 };
  it("maps each known cause and never shows the raw error text", () => {
    expect(registrationWriteError({ message: "submissions_closed" }, band).error).toBe(reg.errors.closed);
    expect(registrationWriteError({ message: "consent_version_mismatch" }, band).error).toBe(reg.errors.consentChanged);
    expect(registrationWriteError({ message: "age_not_eligible" }, band).fieldErrors?.childAge?.en).toMatch(/Only ages 8–12/);
    expect(registrationWriteError({ message: "submission_locked" }, band).error).toBe(reg.errors.locked);
    expect(registrationWriteError({ code: "23505" }, band).error).toBe(reg.errors.duplicate);
    expect(registrationWriteError({ code: "23514" }, band).error).toBe(reg.errors.fix);
    expect(registrationWriteError({ code: "42501" }, band).error).toBe(reg.errors.notAllowed);
    const generic = registrationWriteError({ code: "XX000", message: "boom for private.person@example.com 9876543210" }, band);
    expect(generic.error).toBe(reg.errors.saveFailed);
    expect(JSON.stringify(generic)).not.toMatch(/private\.person|9876543210/);
  });
});

describe("masked mobile for display", () => {
  it("keeps only the last three digits", () => {
    expect(maskMobile("+919876543210")).toBe("+91 ••••• ••210");
    expect(maskMobile("09876543210")).toBe("+91 ••••• ••210");
    expect(maskMobile("garbage")).toBe("••••••••••");
  });
});
