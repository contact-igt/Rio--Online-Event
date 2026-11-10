import { describe, expect, it } from "vitest";
import { config } from "./proxy";

describe("website proxy", () => {
  it("runs only on the parent routes that use the session, so the public pages stay static and no staff route lives here", () => {
    expect(config.matcher).toEqual(["/signin/:path*", "/account", "/events/:slug/register"]);
    for (const path of ["/", "/events/:slug", "/images/:path*", "/admin/:path*", "/judge/:path*", "/staff/:path*"]) expect(config.matcher).not.toContain(path);
  });
});
