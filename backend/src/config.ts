import { z } from "zod";

// Environment validation. Fail closed at start-up. Error text is built from the variable NAME and a fixed message only, never from the
// value, so a mistyped secret (for example a database URL with a password) cannot reach a log or a terminal.

export type LogLevel = "debug" | "info" | "warn" | "error";
/** Which server speaks the MySQL protocol: the production MySQL 8, or the MariaDB that XAMPP ships for local development. It selects the migration folder. */
export type MysqlEngine = "mysql" | "mariadb";
export type MysqlConfig = {
  dialect: "mysql";
  engine: MysqlEngine;
  host: string;
  port: number;
  user: string;
  /** Secret. Never log this object; the logger redacts the key name, but the safe habit is to log host and port only. */
  password: string;
  database: string;
  poolSize: number;
  connectTimeoutMs: number;
};
export type SqliteConfig = { dialect: "sqlite"; path: string };
export type DatabaseConfig = MysqlConfig | SqliteConfig;
export type SameSite = "strict" | "lax" | "none";
export type AuthConfig = {
  /** Browser origins allowed to call the API with credentials (the admin site). Empty means no browser may. */
  allowedOrigins: string[];
  /** How many reverse proxies sit in front (Railway: 1), so that req.ip is the client and not the proxy. */
  trustProxyHops: number;
  sessionTtlMs: number;
  sessionIdleMs: number;
  argon2: { memoryKib: number; passes: number };
  cookieSecure: boolean;
  cookieSameSite: SameSite;
};
export type RegistrationConfig = {
  /** Origins of the public website. Only these may create or change a registration, or recover one. Empty means none (every such request is refused). */
  publicOrigins: string[];
  /** How long a recovery code (and the cookie that carries it) stays valid. */
  tokenTtlMs: number;
};
export type Config = {
  env: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: LogLevel;
  bodyLimitBytes: number;
  shutdownTimeoutMs: number;
  /** Validated here and opened by `db/open.ts`; null when no database is configured. */
  database: DatabaseConfig | null;
  auth: AuthConfig;
  registration: RegistrationConfig;
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

const integer = (min: number, max: number, fallback: number) => z.coerce.number().int().min(min).max(max).default(fallback);

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
const DATABASE_NAME = /^[A-Za-z0-9_]{1,64}$/;

/** Splits ALLOWED_ORIGINS. An entry that is not a plain origin becomes null so the caller can name the variable without echoing the value. */
function parseOrigins(raw: string | undefined): (string | null)[] | undefined {
  if (raw === undefined) return undefined;
  const entries = raw.split(",").map((e) => e.trim()).filter((e) => e !== "");
  return entries.map((entry) => {
    try {
      const url = new URL(entry);
      // A real host name or address only: the URL parser would accept "*" in a host, which must never look like a wildcard here.
      const plainHost = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(url.hostname) || /^\[[0-9a-f:.]+\]$/.test(url.hostname);
      return (url.protocol === "https:" || url.protocol === "http:") && plainHost && !entry.includes("*") && url.origin === entry ? entry : null;
    } catch {
      return null;
    }
  });
}

/** Parses a mysql:// URL. Returns null for anything unusable; it never throws and never echoes the input. */
export function parseMysqlUrl(raw: string): Omit<MysqlConfig, "dialect" | "engine" | "poolSize" | "connectTimeoutMs"> | null {
  try {
    const url = new URL(raw);
    const database = decodeURIComponent(url.pathname.slice(1));
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (url.protocol !== "mysql:" || host === "" || user === "" || url.search !== "" || url.hash !== "" || !DATABASE_NAME.test(database)) return null;
    return { host, port: url.port === "" ? 3306 : Number(url.port), user, password, database };
  } catch {
    return null;
  }
}

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().min(1).max(253).optional(),
    PORT: integer(1, 65535, 4000),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    BODY_LIMIT_BYTES: integer(1024, 1_048_576, 102_400),
    SHUTDOWN_TIMEOUT_SECONDS: integer(1, 120, 10),
    DB_DIALECT: z.enum(["mysql", "sqlite"]).optional(),
    DB_ENGINE: z.enum(["mysql", "mariadb"]).optional(),
    DATABASE_URL: z.string().optional(),
    DB_ALLOWED_HOST: z.string().min(1).max(253).optional(),
    DB_POOL_SIZE: integer(1, 50, 10),
    DB_CONNECT_TIMEOUT_SECONDS: integer(1, 60, 10),
    SQLITE_PATH: z.string().min(1).optional(),
    ALLOWED_ORIGINS: z.string().max(2000).optional(),
    PUBLIC_ORIGINS: z.string().max(2000).optional(),
    REGISTRATION_TOKEN_DAYS: integer(1, 90, 30),
    TRUST_PROXY_HOPS: integer(0, 5, 0),
    SESSION_TTL_HOURS: integer(1, 72, 8),
    SESSION_IDLE_MINUTES: integer(5, 720, 60),
    ARGON2_MEMORY_KIB: integer(8, 1_048_576, 65_536),
    ARGON2_PASSES: integer(1, 10, 3),
    SESSION_COOKIE_SAMESITE: z.enum(["strict", "lax", "none"]).default("strict"),
  })
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    const production = env.NODE_ENV === "production";
    for (const name of ["ALLOWED_ORIGINS", "PUBLIC_ORIGINS"] as const) {
      for (const origin of parseOrigins(env[name]) ?? []) {
        if (origin === null) fail(name, "must be a comma-separated list of origins such as https://www.example.org (no path)");
        else if (production && !origin.startsWith("https://")) fail(name, "must use https in production");
      }
    }
    if (production && env.ARGON2_MEMORY_KIB < 19_456) fail("ARGON2_MEMORY_KIB", "must be at least 19456 in production");
    if (production && env.ARGON2_PASSES < 2) fail("ARGON2_PASSES", "must be at least 2 in production");
    if (env.SESSION_COOKIE_SAMESITE === "none" && !production) fail("SESSION_COOKIE_SAMESITE", "none needs a Secure cookie, which is only used in production");
    if (production && env.DB_DIALECT !== undefined && (parseOrigins(env.ALLOWED_ORIGINS)?.length ?? 0) === 0) fail("ALLOWED_ORIGINS", "is required in production when a database is configured");
    if (env.DB_DIALECT === undefined) {
      if (env.DATABASE_URL !== undefined || env.SQLITE_PATH !== undefined) fail("DB_DIALECT", "must be set when a database setting is present");
      return;
    }
    if (env.DB_ENGINE !== undefined && env.DB_DIALECT !== "mysql") fail("DB_ENGINE", "only applies when DB_DIALECT=mysql");
    if (env.DB_ENGINE === "mariadb" && production) fail("DB_ENGINE", "mariadb is for local development only and is refused in production");
    if (env.DB_DIALECT === "sqlite") {
      if (env.NODE_ENV === "production") fail("DB_DIALECT", "sqlite is not allowed in production");
      if (env.SQLITE_PATH === undefined) return fail("SQLITE_PATH", "is required when DB_DIALECT=sqlite");
      if (env.DATABASE_URL !== undefined) fail("DATABASE_URL", "must not be set when DB_DIALECT=sqlite");
      // Tests may only touch a throw-away database.
      if (env.NODE_ENV === "test" && env.SQLITE_PATH !== ":memory:" && !env.SQLITE_PATH.endsWith(".test.sqlite")) {
        fail("SQLITE_PATH", "must be :memory: or end with .test.sqlite when NODE_ENV=test");
      }
      return;
    }
    if (env.DATABASE_URL === undefined) return fail("DATABASE_URL", "is required when DB_DIALECT=mysql");
    const target = parseMysqlUrl(env.DATABASE_URL);
    if (!target) return fail("DATABASE_URL", "must be a mysql:// URL with a user, a host, a simple database name and no query string");
    if (env.DB_ALLOWED_HOST === undefined) return fail("DB_ALLOWED_HOST", "is required when DB_DIALECT=mysql");
    // The host in the URL must be the one the operator named, so a stray or copied URL cannot silently point the app elsewhere.
    if (target.host !== env.DB_ALLOWED_HOST.toLowerCase()) fail("DATABASE_URL", "host does not match DB_ALLOWED_HOST");
    const loopback = LOOPBACK.has(target.host);
    const testName = target.database.endsWith("_test");
    if (env.NODE_ENV === "test") {
      if (!loopback) fail("DATABASE_URL", "must point at a local database when NODE_ENV=test");
      if (!testName) fail("DATABASE_URL", "database name must end with _test when NODE_ENV=test");
    } else {
      if (testName) fail("DATABASE_URL", "a database whose name ends with _test is only allowed when NODE_ENV=test");
      if (env.NODE_ENV === "production" && loopback) fail("DATABASE_URL", "must not be a local database in production");
    }
  });

export function loadConfig(source: Record<string, string | undefined>): Config {
  // An empty value counts as "not set" (hosting dashboards often leave blanks).
  const present = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `- ${i.path.join(".") || "(environment)"}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  const target = e.DB_DIALECT === "mysql" && e.DATABASE_URL !== undefined ? parseMysqlUrl(e.DATABASE_URL) : null;
  const database: DatabaseConfig | null = target
    ? { dialect: "mysql", engine: e.DB_ENGINE ?? "mysql", ...target, poolSize: e.DB_POOL_SIZE, connectTimeoutMs: e.DB_CONNECT_TIMEOUT_SECONDS * 1000 }
    : e.DB_DIALECT === "sqlite" && e.SQLITE_PATH !== undefined
      ? { dialect: "sqlite", path: e.SQLITE_PATH }
      : null;
  return {
    env: e.NODE_ENV,
    // Railway must bind all interfaces; a developer machine should not expose the port to the network.
    host: e.HOST ?? (e.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"),
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    bodyLimitBytes: e.BODY_LIMIT_BYTES,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_SECONDS * 1000,
    database,
    auth: {
      allowedOrigins: (parseOrigins(e.ALLOWED_ORIGINS) ?? []).filter((o): o is string => o !== null),
      trustProxyHops: e.TRUST_PROXY_HOPS,
      sessionTtlMs: e.SESSION_TTL_HOURS * 3_600_000,
      sessionIdleMs: e.SESSION_IDLE_MINUTES * 60_000,
      argon2: { memoryKib: e.ARGON2_MEMORY_KIB, passes: e.ARGON2_PASSES },
      cookieSecure: e.NODE_ENV === "production",
      cookieSameSite: e.SESSION_COOKIE_SAMESITE,
    },
    registration: {
      publicOrigins: (parseOrigins(e.PUBLIC_ORIGINS) ?? []).filter((o): o is string => o !== null),
      tokenTtlMs: e.REGISTRATION_TOKEN_DAYS * 86_400_000,
    },
  };
}
