import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";

const failure = (env: Record<string, string>): string => {
  try {
    loadConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error("expected loadConfig to throw");
};

describe("loadConfig", () => {
  it("applies safe defaults for development", () => {
    expect(loadConfig({})).toEqual({
      env: "development",
      host: "127.0.0.1",
      port: 4000,
      logLevel: "info",
      bodyLimitBytes: 102_400,
      shutdownTimeoutMs: 10_000,
      database: null,
      auth: {
        allowedOrigins: [],
        trustProxyHops: 0,
        sessionTtlMs: 8 * 3_600_000,
        sessionIdleMs: 60 * 60_000,
        argon2: { memoryKib: 65_536, passes: 3 },
        cookieSecure: false,
        cookieSameSite: "strict",
      },
      registration: { publicOrigins: [], tokenTtlMs: 30 * 86_400_000 },
    });
  });

  it("binds all interfaces in production (Railway) and honours PORT and HOST", () => {
    expect(loadConfig({ NODE_ENV: "production", PORT: "8080" })).toMatchObject({ host: "0.0.0.0", port: 8080 });
    expect(loadConfig({ NODE_ENV: "production", HOST: "10.0.0.5" }).host).toBe("10.0.0.5");
  });

  it("treats empty values as not set", () => {
    expect(loadConfig({ PORT: "", HOST: "", DB_DIALECT: "" })).toMatchObject({ port: 4000, database: null });
  });

  it.each([
    [{ PORT: "abc" }, "PORT"],
    [{ PORT: "0" }, "PORT"],
    [{ PORT: "70000" }, "PORT"],
    [{ PORT: "80.5" }, "PORT"],
    [{ NODE_ENV: "staging" }, "NODE_ENV"],
    [{ LOG_LEVEL: "verbose" }, "LOG_LEVEL"],
    [{ BODY_LIMIT_BYTES: "10" }, "BODY_LIMIT_BYTES"],
    [{ SHUTDOWN_TIMEOUT_SECONDS: "0" }, "SHUTDOWN_TIMEOUT_SECONDS"],
    [{ DB_DIALECT: "postgres" }, "DB_DIALECT"],
  ])("rejects %j", (env, name) => {
    expect(failure(env)).toContain(`- ${name}:`);
  });

  describe("database selection", () => {
    const mysql = (over: Record<string, string> = {}) => ({ DB_DIALECT: "mysql", DATABASE_URL: "mysql://app:pw@db.internal:3306/rio_hospital", DB_ALLOWED_HOST: "db.internal", ALLOWED_ORIGINS: "https://admin.example.org", ...over });

    it("accepts sqlite for development and a mysql:// URL whose host is the allowed host", () => {
      expect(loadConfig({ DB_DIALECT: "sqlite", SQLITE_PATH: "./data/dev.sqlite" }).database).toEqual({ dialect: "sqlite", path: "./data/dev.sqlite" });
      expect(loadConfig(mysql({ NODE_ENV: "production" })).database).toEqual({
        dialect: "mysql", engine: "mysql",
        host: "db.internal",
        port: 3306,
        user: "app",
        password: "pw",
        database: "rio_hospital",
        poolSize: 10,
        connectTimeoutMs: 10_000,
      });
    });

    it("decodes a percent-encoded password and honours the port and pool settings", () => {
      const db = loadConfig(mysql({ DATABASE_URL: "mysql://app:p%40ss%2Fw@db.internal:3307/rio_hospital", DB_POOL_SIZE: "4", DB_CONNECT_TIMEOUT_SECONDS: "3" })).database;
      expect(db).toMatchObject({ password: "p@ss/w", port: 3307, poolSize: 4, connectTimeoutMs: 3000 });
    });

    it("allows the local development database rio_hospital on the loopback address", () => {
      const env = mysql({ DATABASE_URL: "mysql://root:pw@127.0.0.1:3306/rio_hospital", DB_ALLOWED_HOST: "127.0.0.1" });
      expect(loadConfig(env).database).toMatchObject({ host: "127.0.0.1", database: "rio_hospital" });
    });

    it("refuses sqlite in production", () => {
      expect(failure({ NODE_ENV: "production", DB_DIALECT: "sqlite", SQLITE_PATH: "./x.sqlite" })).toContain("sqlite is not allowed in production");
    });

    it("requires the companion settings for the chosen dialect", () => {
      expect(failure({ DB_DIALECT: "mysql" })).toContain("DATABASE_URL: is required");
      expect(failure({ DB_DIALECT: "sqlite" })).toContain("SQLITE_PATH: is required");
      expect(failure({ DB_DIALECT: "mysql", DATABASE_URL: "mysql://u:p@h/db" })).toContain("DB_ALLOWED_HOST: is required");
    });

    it("fails closed when the URL host is not the allowed host", () => {
      expect(failure(mysql({ DB_ALLOWED_HOST: "other.internal" }))).toContain("host does not match DB_ALLOWED_HOST");
      expect(loadConfig(mysql({ DB_ALLOWED_HOST: "DB.Internal" })).database).toMatchObject({ host: "db.internal" }); // host names are case-insensitive
    });

    it("refuses a database setting without a dialect, and a URL next to sqlite", () => {
      expect(failure({ DATABASE_URL: "mysql://u:p@h/db" })).toContain("DB_DIALECT: must be set");
      expect(failure({ DB_DIALECT: "sqlite", SQLITE_PATH: "a.sqlite", DATABASE_URL: "mysql://u:p@h/db" })).toContain("DATABASE_URL: must not be set");
    });

    it.each([
      "postgres://u:p@h/db",
      "mysql://u:p@/db",
      "mysql://u:p@h",
      "mysql://:p@h/db",
      "mysql://u:p@h/db?ssl=true",
      "mysql://u:p@h/db-name",
      "mysql://u:p@h/db/extra",
      "not a url",
    ])("rejects the database URL %s", (url) => {
      expect(failure(mysql({ DATABASE_URL: url, DB_ALLOWED_HOST: "h" }))).toContain("DATABASE_URL: must be a mysql:// URL");
    });

    describe("test environment: never a production database", () => {
      const test = (over: Record<string, string> = {}) => mysql({ NODE_ENV: "test", DATABASE_URL: "mysql://u:p@127.0.0.1:3306/rio_test", DB_ALLOWED_HOST: "127.0.0.1", ...over });
      it("accepts a local database named *_test", () => {
        expect(loadConfig(test()).database).toMatchObject({ host: "127.0.0.1", database: "rio_test" });
      });
      it("refuses a remote host, and a database not named *_test (including rio_hospital)", () => {
        expect(failure(test({ DATABASE_URL: "mysql://u:p@db.internal:3306/rio_test", DB_ALLOWED_HOST: "db.internal" }))).toContain("local database when NODE_ENV=test");
        expect(failure(test({ DATABASE_URL: "mysql://u:p@127.0.0.1:3306/rio_hospital" }))).toContain("must end with _test when NODE_ENV=test");
      });
      it("only allows sqlite in memory or in a .test.sqlite file", () => {
        expect(loadConfig({ NODE_ENV: "test", DB_DIALECT: "sqlite", SQLITE_PATH: ":memory:" }).database).toEqual({ dialect: "sqlite", path: ":memory:" });
        expect(failure({ NODE_ENV: "test", DB_DIALECT: "sqlite", SQLITE_PATH: "./data/dev.sqlite" })).toContain("SQLITE_PATH: must be :memory:");
      });
    });

    describe("outside tests and production", () => {
      it("refuses a *_test database unless NODE_ENV=test, and a local database in production", () => {
        expect(failure(mysql({ DATABASE_URL: "mysql://u:p@db.internal/rio_test" }))).toContain("only allowed when NODE_ENV=test");
        expect(failure(mysql({ NODE_ENV: "production", DATABASE_URL: "mysql://u:p@localhost/rio", DB_ALLOWED_HOST: "localhost" }))).toContain("must not be a local database in production");
      });
    });

    it.each([
      [{ DB_POOL_SIZE: "0" }, "DB_POOL_SIZE"],
      [{ DB_POOL_SIZE: "500" }, "DB_POOL_SIZE"],
      [{ DB_CONNECT_TIMEOUT_SECONDS: "0" }, "DB_CONNECT_TIMEOUT_SECONDS"],
    ])("rejects %j", (over, name) => {
      expect(failure(mysql(over))).toContain(`- ${name}:`);
    });
  });

  it("never puts a configured value into the error text", () => {
    const secret = "S3cretPassw0rd!";
    const text = failure({ DB_DIALECT: "mysql", DATABASE_URL: `postgres://admin:${secret}@h/db`, DB_ALLOWED_HOST: "other-host", PORT: `${secret}`, LOG_LEVEL: secret });
    expect(text).not.toContain(secret);
    expect(text).not.toContain("admin");
  });

  it("lists every problem at once", () => {
    const text = failure({ PORT: "x", LOG_LEVEL: "y" });
    expect(text).toContain("- PORT:");
    expect(text).toContain("- LOG_LEVEL:");
  });
});

describe("loadConfig: staff authentication settings", () => {
  const prod = { NODE_ENV: "production", DB_DIALECT: "mysql", DATABASE_URL: "mysql://u:p@db.internal:3306/rio", DB_ALLOWED_HOST: "db.internal", ALLOWED_ORIGINS: "https://admin.example.org" };

  it("reads the allowed origins, proxy hops, lifetimes and Argon2 cost", () => {
    expect(
      loadConfig({ ALLOWED_ORIGINS: "http://localhost:3001, https://admin.example.org", TRUST_PROXY_HOPS: "1", SESSION_TTL_HOURS: "12", SESSION_IDLE_MINUTES: "30", ARGON2_MEMORY_KIB: "32768", ARGON2_PASSES: "2" }).auth,
    ).toEqual({
      allowedOrigins: ["http://localhost:3001", "https://admin.example.org"],
      trustProxyHops: 1,
      sessionTtlMs: 12 * 3_600_000,
      sessionIdleMs: 30 * 60_000,
      argon2: { memoryKib: 32_768, passes: 2 },
      cookieSecure: false,
      cookieSameSite: "strict",
    });
  });

  it("uses a Secure cookie in production only", () => {
    expect(loadConfig(prod).auth.cookieSecure).toBe(true);
    expect(loadConfig({ ALLOWED_ORIGINS: "http://localhost:3001" }).auth.cookieSecure).toBe(false);
  });

  it.each([
    [{ ALLOWED_ORIGINS: "admin.example.org" }, "ALLOWED_ORIGINS"],
    [{ ALLOWED_ORIGINS: "https://admin.example.org/path" }, "ALLOWED_ORIGINS"],
    [{ ALLOWED_ORIGINS: "ftp://admin.example.org" }, "ALLOWED_ORIGINS"],
    [{ ALLOWED_ORIGINS: "https://a.example.org, nonsense" }, "ALLOWED_ORIGINS"],
    [{ TRUST_PROXY_HOPS: "9" }, "TRUST_PROXY_HOPS"],
    [{ SESSION_TTL_HOURS: "0" }, "SESSION_TTL_HOURS"],
    [{ SESSION_IDLE_MINUTES: "1" }, "SESSION_IDLE_MINUTES"],
    [{ ARGON2_MEMORY_KIB: "4" }, "ARGON2_MEMORY_KIB"],
    [{ SESSION_COOKIE_SAMESITE: "sometimes" }, "SESSION_COOKIE_SAMESITE"],
    [{ SESSION_COOKIE_SAMESITE: "none" }, "SESSION_COOKIE_SAMESITE"],
  ])("refuses %j and names %s", (env, name) => {
    expect(failure(env)).toContain(name);
  });

  it("fails closed in production: https origins, a real Argon2 cost, and at least one origin when a database is configured", () => {
    expect(failure({ ...prod, ALLOWED_ORIGINS: "http://admin.example.org" })).toContain("must use https");
    expect(failure({ ...prod, ARGON2_MEMORY_KIB: "1024" })).toContain("ARGON2_MEMORY_KIB");
    expect(failure({ ...prod, ARGON2_PASSES: "1" })).toContain("ARGON2_PASSES");
    const without = Object.fromEntries(Object.entries(prod).filter(([name]) => name !== "ALLOWED_ORIGINS"));
    expect(failure(without)).toContain("ALLOWED_ORIGINS");
    expect(failure({ ...without, ALLOWED_ORIGINS: " , " })).toContain("ALLOWED_ORIGINS");
    expect(loadConfig({ NODE_ENV: "production" }).auth.allowedOrigins).toEqual([]); // no database, no staff routes: nothing to protect
    expect(loadConfig({ ...prod, SESSION_COOKIE_SAMESITE: "none" }).auth.cookieSameSite).toBe("none");
  });

  it("does not echo a bad origin back in the error text", () => {
    expect(failure({ ALLOWED_ORIGINS: "https://secret-host.example.org/with/path" })).not.toContain("secret-host");
  });
});

describe("loadConfig: public registration settings", () => {
  it("reads the public website origins and the recovery code lifetime, separately from the admin origins", () => {
    const config = loadConfig({ PUBLIC_ORIGINS: "http://localhost:3000, https://www.example.org", ALLOWED_ORIGINS: "http://localhost:3001", REGISTRATION_TOKEN_DAYS: "14" });
    expect(config.registration).toEqual({ publicOrigins: ["http://localhost:3000", "https://www.example.org"], tokenTtlMs: 14 * 86_400_000 });
    expect(config.auth.allowedOrigins).toEqual(["http://localhost:3001"]); // the two lists never mix
  });

  it.each([
    [{ PUBLIC_ORIGINS: "www.example.org" }, "PUBLIC_ORIGINS"],
    [{ PUBLIC_ORIGINS: "https://www.example.org/register" }, "PUBLIC_ORIGINS"],
    [{ PUBLIC_ORIGINS: "https://a.example.org, nonsense" }, "PUBLIC_ORIGINS"],
    [{ REGISTRATION_TOKEN_DAYS: "0" }, "REGISTRATION_TOKEN_DAYS"],
    [{ REGISTRATION_TOKEN_DAYS: "91" }, "REGISTRATION_TOKEN_DAYS"],
  ])("refuses %j and names %s", (env, name) => {
    expect(failure(env)).toContain(name);
  });

  it("requires https for public origins in production, without echoing the value", () => {
    const prod = { NODE_ENV: "production", DB_DIALECT: "mysql", DATABASE_URL: "mysql://u:p@db.internal:3306/rio", DB_ALLOWED_HOST: "db.internal", ALLOWED_ORIGINS: "https://admin.example.org" };
    const message = failure({ ...prod, PUBLIC_ORIGINS: "http://insecure-site.example.org" });
    expect(message).toContain("PUBLIC_ORIGINS");
    expect(message).not.toContain("insecure-site");
    expect(loadConfig({ ...prod, PUBLIC_ORIGINS: "https://www.example.org" }).registration.publicOrigins).toEqual(["https://www.example.org"]);
    expect(loadConfig(prod).registration.publicOrigins).toEqual([]); // optional: without it every registration change is simply refused
  });
});
