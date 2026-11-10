import { afterEach, describe, expect, it, vi } from "vitest";

// The development-only registration preview must not exist in production: the route and its layout are a plain 404 that renders nothing.

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

afterEach(() => vi.unstubAllEnvs());

describe("/dev/registration-preview", () => {
  it("is a 404 in production, from the page and from the layout", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { default: Page } = await import("./page");
    const { default: Layout } = await import("../layout");
    expect(() => Page()).toThrow("NEXT_NOT_FOUND");
    expect(() => Layout({ children: null })).toThrow("NEXT_NOT_FOUND");
  });

  it("renders in development and test, and says nothing is saved or sent", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { default: Page } = await import("./page");
    const { default: Layout } = await import("../layout");
    expect(Layout({ children: "x" })).toBe("x");
    const text = JSON.stringify(Page());
    expect(text).toContain("Nothing here is saved, uploaded or sent");
    expect(text).toContain("registration is not opened");
  });

  it("builds the validation-error state from the REAL validator: every required field is refused", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { default: Page } = await import("./page");
    const tree = JSON.stringify(Page());
    for (const field of ["childName", "childAge", "parentName", "mobile", "guardianConsent"]) expect(tree, field).toContain(`"${field}"`);
  });
});
