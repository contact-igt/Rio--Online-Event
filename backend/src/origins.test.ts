import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

// Origin lists are exact: a browser origin is "scheme://host[:port]" and nothing else. These pin the shapes a wildcard-minded mistake could take.

const fail = (env: Record<string, string>) => {
  try {
    loadConfig(env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected loadConfig to throw");
};

describe.each(["ALLOWED_ORIGINS", "PUBLIC_ORIGINS"])("%s", (name) => {
  it.each([
    "*",
    "http://*",
    "http://*.example.org",
    "https://*.example.org",
    "http://localhost:3000/",
    "http://localhost:3000/path",
    "HTTP://LOCALHOST:3000",
    "localhost:3000",
    "//localhost:3000",
    "http://localhost:3000, *",
    "null",
    "file:///tmp/x",
    "javascript:alert(1)",
    "http://user:pass@localhost:3000",
  ])("refuses %j and names the variable without echoing the value", (value) => {
    const message = fail({ [name]: value });
    expect(message).toContain(name);
    if (value.length > 6) expect(message).not.toContain(value);
  });

  it("accepts the local development origins and nothing is widened by them", () => {
    const config = loadConfig({ [name]: name === "ALLOWED_ORIGINS" ? "http://localhost:3001" : "http://localhost:3000" });
    const list = name === "ALLOWED_ORIGINS" ? config.auth.allowedOrigins : config.registration.publicOrigins;
    expect(list).toEqual([name === "ALLOWED_ORIGINS" ? "http://localhost:3001" : "http://localhost:3000"]);
  });
});

describe("the two lists stay separate", () => {
  it("the admin origin is not a public origin and the public origin is not an admin origin", () => {
    const config = loadConfig({ ALLOWED_ORIGINS: "http://localhost:3001", PUBLIC_ORIGINS: "http://localhost:3000" });
    expect(config.auth.allowedOrigins).toEqual(["http://localhost:3001"]);
    expect(config.registration.publicOrigins).toEqual(["http://localhost:3000"]);
    expect(config.auth.allowedOrigins).not.toContain("http://localhost:3000");
    expect(config.registration.publicOrigins).not.toContain("http://localhost:3001");
  });

  it("the API's own address (port 4000) is in neither list: it serves JSON, never a page that calls the API", () => {
    const config = loadConfig({ ALLOWED_ORIGINS: "http://localhost:3001", PUBLIC_ORIGINS: "http://localhost:3000" });
    for (const list of [config.auth.allowedOrigins, config.registration.publicOrigins]) expect(list.some((o) => o.endsWith(":4000"))).toBe(false);
  });
});
