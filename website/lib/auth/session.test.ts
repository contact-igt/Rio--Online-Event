import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class Redirect extends Error {
    constructor(public url: string) {
      super(`redirect:${url}`);
    }
  }
  return { Redirect, getUser: vi.fn(), broken: { config: false } };
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new h.Redirect(url);
  },
}));
vi.mock("@/lib/supabase/server", async () => {
  const { SupabaseConfigError } = await import("@/lib/supabase/config");
  return {
    createClient: async () => {
      if (h.broken.config) throw new SupabaseConfigError("not configured");
      return { auth: { getUser: h.getUser } };
    },
  };
});

import { getParent, requireParent } from "./session";

const redirectTarget = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    if (e instanceof h.Redirect) return e.url;
    throw e;
  }
};

beforeEach(() => {
  h.broken.config = false;
  h.getUser.mockReset();
});

describe("protected routes", () => {
  it("send a visitor without a valid session to sign-in, keeping the selected competition", async () => {
    h.getUser.mockResolvedValue({ data: { user: null }, error: { message: "no session" } });
    expect(await redirectTarget(requireParent("kutti-pesalar"))).toBe("/signin?event=kutti-pesalar");
    expect(await redirectTarget(requireParent(null))).toBe("/signin");
  });

  it("validate the session with the Auth server (getUser), not just the cookie", async () => {
    h.getUser.mockResolvedValue({ data: { user: null }, error: null });
    await redirectTarget(requireParent(null));
    expect(h.getUser).toHaveBeenCalledTimes(1);
  });

  it("let a signed-in parent through and return the user", async () => {
    const user = { id: "u1", email: "a@example.com" };
    h.getUser.mockResolvedValue({ data: { user }, error: null });
    await expect(requireParent("tamilil-sollu")).resolves.toEqual(user);
  });

  it("send visitors to sign-in (not into a loop or a crash) when Supabase is not configured", async () => {
    h.broken.config = true;
    expect(await redirectTarget(requireParent("kutti-pesalar"))).toBe("/signin?event=kutti-pesalar");
    await expect(getParent()).rejects.toThrow(); // the sign-in page catches this and explains
  });
});

describe("session restoration", () => {
  it("returns the user for a returning parent whose cookie is still valid", async () => {
    h.getUser.mockResolvedValue({ data: { user: { id: "u1", email: "a@example.com" } }, error: null });
    expect((await getParent())?.id).toBe("u1");
  });
});
